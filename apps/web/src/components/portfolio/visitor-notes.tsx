import {
    normalizeNoteName,
    normalizeNoteText,
    VisitorNote,
    type SiteContent,
} from "@artisann-port/presence/content";
import {
    NOTE_BODY_MAX,
    NOTE_NAME_MAX,
    newSubmissionId,
    type NoteSubmissionId,
    TURNSTILE_ACTION,
} from "@artisann-port/presence/notes";
import { Button } from "@artisann-port/ui/components/button";
import {
    Card,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@artisann-port/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@artisann-port/ui/components/field";
import { Input } from "@artisann-port/ui/components/input";
import {
    ResponsiveClose,
    ResponsiveDialog,
    ResponsiveDialogFooter,
} from "@artisann-port/ui/components/responsive-dialog";
import { Textarea } from "@artisann-port/ui/components/textarea";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
    Cancel01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    PlusSignIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ComponentRef,
    type ReactNode,
} from "react";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";
import { contentAtom, NotesClient, portfolioApiEndpoints } from "@/lib/rpc-client";
import { reconcileOrder, shuffle } from "@/lib/shuffle";

const NOTE_LIMIT = NOTE_BODY_MAX;
const LOCAL_NOTES_KEY = "artisann:visitor-notes";
const noteVariants = {
    enter: (direction: number) => ({ x: direction > 0 ? 20 : -20, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (direction: number) => ({ x: direction > 0 ? -20 : 20, opacity: 0 }),
};
const reducedNoteVariants = {
    enter: { x: 0, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: { x: 0, opacity: 0 },
};
const LocalNote = Schema.Struct({
    id: VisitorNote.fields.id,
    name: VisitorNote.fields.name,
    body: VisitorNote.fields.body,
    submittedAt: VisitorNote.fields.submittedAt,
});
type LocalNote = typeof LocalNote.Type;
/** A note shown in the carousel: a visitor's own draft or an approved server note. */
type NoteEntry = LocalNote | VisitorNote;
const decodeLocalNotes = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(LocalNote)));

/**
 * The page mounts two VisitorNotes placements (mobile and lg). Both must see a
 * note the moment it is submitted — a visitor who posts on mobile and then
 * crosses the lg breakpoint must not lose it until reload. localStorage alone
 * does not notify same-tab writers, so the local list lives in a module store
 * that persists on every write and notifies every mounted instance.
 */
interface LocalNotesState {
    readonly notes: readonly LocalNote[];
    readonly loaded: boolean;
}

const readStoredNotes = (): readonly LocalNote[] => {
    try {
        const stored = window.localStorage.getItem(LOCAL_NOTES_KEY);
        if (stored === null) return [];
        const decoded = decodeLocalNotes(stored);
        return Option.isSome(decoded) ? decoded.value : [];
    } catch {
        // Storage may be blocked; notes submitted this visit still appear immediately.
        return [];
    }
};

let localNotesState: LocalNotesState = { notes: [], loaded: false };
const localNotesListeners = new Set<() => void>();

const setSharedLocalNotes = (update: (previous: readonly LocalNote[]) => readonly LocalNote[]) => {
    const next = update(localNotesState.notes);
    if (next === localNotesState.notes) return;
    localNotesState = { notes: next, loaded: true };
    try {
        window.localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(next));
    } catch {
        // Persistence failed, so the stored copy still names the reconciled
        // ids. Drop it: a reload must not restore a note the server no longer
        // has — or one it never saw.
        try {
            window.localStorage.removeItem(LOCAL_NOTES_KEY);
        } catch {
            // Storage stays unavailable; the in-memory state still applies.
        }
    }
    for (const listener of localNotesListeners) listener();
};

const subscribeLocalNotes = (listener: () => void) => {
    localNotesListeners.add(listener);
    return () => localNotesListeners.delete(listener);
};

const useSharedLocalNotes = (): LocalNotesState => {
    const state = useSyncExternalStore(
        subscribeLocalNotes,
        () => localNotesState,
        () => localNotesState,
    );
    useEffect(() => {
        if (localNotesState.loaded) return;
        const stored = readStoredNotes();
        localNotesState = { notes: stored, loaded: true };
        for (const listener of localNotesListeners) listener();
    }, []);
    return state;
};

/**
 * The composer ships disabled until the owner publishes the Turnstile site key AND flips the
 * explicit rollout flag. A configured key alone must never open a live submission path.
 */
const TURNSTILE_SITE_KEY: string | undefined = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
const COMPOSER_ENABLED =
    TURNSTILE_SITE_KEY !== undefined &&
    TURNSTILE_SITE_KEY.length > 0 &&
    import.meta.env.PUBLIC_NOTES_COMPOSER === "enabled";

type SubmitState = "idle" | "submitting" | "sent" | "failed";

interface TurnstileApi {
    render: (
        container: HTMLElement,
        options: {
            sitekey: string;
            action: string;
            callback: (token: string) => void;
            "expired-callback": () => void;
            "error-callback": () => void;
        },
    ) => string;
    remove: (widgetId: string) => void;
    ready: (callback: () => void) => void;
}

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

function TurnstileChallenge({
    siteKey,
    onToken,
}: {
    siteKey: string;
    onToken: (token: string | null) => void;
}) {
    const containerRef = useRef<ComponentRef<"div">>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (container === null) return;

        let widgetId: string | null = null;
        let destroyed = false;
        let framesLeft = 240;

        const isLocal =
            window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

        const render = () => {
            if (widgetId !== null || window.turnstile === undefined) return;
            try {
                widgetId = window.turnstile.render(container, {
                    sitekey: isLocal ? "1x00000000000000000000AA" : siteKey,
                    action: TURNSTILE_ACTION,
                    callback: (token) => onToken(token),
                    "expired-callback": () => onToken(null),
                    "error-callback": () => onToken(null),
                });
            } catch {
                // The challenge is third-party code: a failure must leave the
                // composer mounted with submit disabled, never tear down the page.
                onToken(null);
                return;
            }
            if (isLocal && widgetId) {
                // Automatically acquire token for local development testing
                onToken("XXXX.DUMMY.TOKEN.XXXX");
            }
        };

        const tick = () => {
            if (destroyed || widgetId !== null) return;
            const api = window.turnstile;
            if (api !== undefined) {
                try {
                    // `ready()` throws until api.js finishes initializing, so a
                    // throw falls back to an immediate render attempt.
                    api.ready(render);
                } catch {
                    render();
                }
            }
            if (widgetId === null && framesLeft > 0) {
                framesLeft -= 1;
                requestAnimationFrame(tick);
            }
        };

        tick();

        return () => {
            destroyed = true;
            if (widgetId !== null) window.turnstile?.remove(widgetId);
            onToken(null);
        };
    }, [siteKey, onToken]);

    return <div ref={containerRef} className="flex justify-center" />;
}

function VisitorNotesContent({ initial }: { initial: SiteContent }) {
    const id = useId();
    const content = useSiteContent(initial);
    const notes = content.notes;
    // Read the same atom the content hook renders to tell "no notes" apart from "not known
    // yet": an unresolved or failed document read must never be published as an empty list,
    // which is what a first visit saw while the request was still in flight.
    const contentResult = useAtomValue(contentAtom(portfolioApiEndpoints.rpcUrl));
    const notesKnown = Option.isSome(AsyncResult.value(contentResult));
    const { notes: localNotes, loaded: localNotesLoaded } = useSharedLocalNotes();
    const allNotes = useMemo(
        () => [
            ...localNotes.filter((localNote) => !notes.some((note) => note.id === localNote.id)),
            ...notes,
        ],
        [localNotes, notes],
    );
    /**
     * The shuffled browse order, seeded from the first non-empty list before paint so which note
     * greets a visitor varies per reload. Later documents reconcile by id — an approved local
     * note, an owner edit or a fresh approval keeps the visited order and appends — so browsing
     * never reshuffles mid-carousel.
     */
    const [orderedNotes, setOrderedNotes] = useState<readonly NoteEntry[]>([]);
    useLayoutEffect(() => {
        setOrderedNotes((previous) => {
            if (allNotes.length === 0) return previous.length === 0 ? previous : [];
            if (previous.length === 0) return shuffle(allNotes);
            return reconcileOrder(previous, allNotes, (note) => note.id);
        });
    }, [allNotes]);
    // The shuffle lands before paint, so the unshuffled list is only the server's first pass.
    const displayNotes = orderedNotes.length > 0 ? orderedNotes : allNotes;
    // An approved note becomes server-authoritative under the same id. Prune the
    // local copy and persist the reduction: otherwise an owner deletion leaves no
    // server note, and a reload would resurrect the stale local record.
    useEffect(() => {
        if (notes.length === 0) return;
        setSharedLocalNotes((previous) => {
            const remaining = previous.filter(
                (localNote) => !notes.some((note) => note.id === localNote.id),
            );
            if (remaining.length === previous.length) return previous;
            return remaining;
        });
    }, [notes]);
    const submitNote = useAtomSet(NotesClient.mutation("notes.submit"), {
        mode: "promiseExit",
    });

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [composerOpen, setComposerOpen] = useState(false);
    const [direction, setDirection] = useState<1 | -1>(1);
    const reduceMotion = useReducedMotion();
    const activeNoteRef = useRef<HTMLDivElement>(null);
    const [noteHeight, setNoteHeight] = useState<number>();
    const activeIndex = Math.max(
        0,
        displayNotes.findIndex((note) => note.id === selectedId),
    );
    const active = displayNotes[activeIndex];

    useLayoutEffect(() => {
        const element = activeNoteRef.current;
        if (element === null) {
            setNoteHeight(undefined);
            return;
        }
        const measure = () => setNoteHeight(element.offsetHeight);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [active?.id]);

    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [token, setToken] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [submitState, setSubmitState] = useState<SubmitState>("idle");
    const [feedback, setFeedback] = useState("");
    const lastSubmitted = useRef<{ id: NoteSubmissionId; payload: string } | null>(null);
    const nameId = `${id}-name`;
    const noteId = `${id}-note`;
    const countId = `${id}-count`;
    const unavailableId = `${id}-unavailable`;

    const step = (delta: 1 | -1) => {
        const next =
            displayNotes[(activeIndex + delta + displayNotes.length) % displayNotes.length];
        if (next !== undefined) {
            setDirection(delta);
            setSelectedId(next.id);
        }
    };

    // React event boundary: promiseExit already owns the Effect through the mounted
    // mutation atom. Wrapping this Promise back into Effect would split ownership.
    // oxlint-disable-next-line effecttsgo/async-function
    const submit = async () => {
        if (submitState === "submitting" || submitState === "sent") return;
        const trimmedName = normalizeNoteName(name);
        const trimmedBody = normalizeNoteText(note);
        if (
            !COMPOSER_ENABLED ||
            trimmedBody === null ||
            trimmedBody.length > NOTE_LIMIT ||
            (trimmedName?.length ?? 0) > NOTE_NAME_MAX
        )
            return;
        const payload = JSON.stringify({
            name: trimmedName,
            body: trimmedBody,
        });
        // The same draft keeps the same submission id across retries; editing the note after
        // an uncertain failure starts a new submission instead of reusing a conflicting id.
        const id =
            lastSubmitted.current?.payload === payload
                ? lastSubmitted.current.id
                : newSubmissionId();
        lastSubmitted.current = { id, payload };

        setSubmitState("submitting");
        setFeedback("");

        if (token === null) {
            setSubmitState("failed");
            setFeedback("Finish the verification first, then send your note.");
            return;
        }
        const submission = {
            id,
            name: trimmedName,
            body: trimmedBody,
            turnstileToken: token,
        };
        const exit = await submitNote({ payload: submission });

        // Turnstile tokens are single-use: whatever the outcome, the next send re-acquires a
        // fresh challenge instead of replaying a consumed token.
        setToken(null);
        setAttempt((current) => current + 1);

        if (Exit.isFailure(exit) || exit.value.status !== "pending" || exit.value.id !== id) {
            // The draft and the retry id survive a failure, so a second click resubmits the
            // same submission instead of creating a duplicate pending note.
            setSubmitState("failed");
            setFeedback("Sending failed. Your note is still here — please try again.");
            return;
        }

        const submitted: LocalNote = {
            id,
            name: trimmedName,
            body: trimmedBody,
            submittedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
        setSharedLocalNotes((previous) => [
            submitted,
            ...previous.filter((localNote) => localNote.id !== id),
        ]);
        setSelectedId(id);
        setSubmitState("sent");
        setFeedback("Shown here and sent for review. It will be public after approval.");
    };

    const busy = submitState === "submitting";
    const invalid =
        normalizeNoteText(note) === null ||
        note.trim().length > NOTE_LIMIT ||
        (normalizeNoteName(name)?.length ?? 0) > NOTE_NAME_MAX ||
        token === null;

    const editDraft = () => {
        if (submitState === "sent") {
            setSubmitState("idle");
            setFeedback("");
        }
    };

    const description = COMPOSER_ENABLED
        ? "Your note will be public after approval. Please keep it kind."
        : "Posting is not available yet.";

    /**
     * The notes card carries the trigger, so it is built per branch: a dialog
     * trigger at `lg` and up, a drawer trigger below it. Base UI resolves both
     * through the root they are rendered in.
     */
    const noteCard = (trigger: ReactNode) => (
        <Card
            variant="note"
            role="region"
            aria-labelledby={`${id}-heading`}
            data-portfolio-section="visitor-notes"
            className="relative h-full min-h-52.25 gap-3 overflow-hidden"
        >
            <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0 right-0 size-5 bg-note-fold [clip-path:polygon(0_0,100%_100%,0_100%)]"
            />
            <CardHeader className="flex flex-1 flex-col gap-2">
                <CardTitle tone="heading">
                    <h2 id={`${id}-heading`}>Leave a little note.</h2>
                </CardTitle>
                {active === undefined ? (
                    <CardDescription>
                        A thought, a hello, or something kind.
                        {notesKnown && localNotesLoaded ? (
                            <>
                                <br />
                                Be the first to leave one.
                            </>
                        ) : null}
                    </CardDescription>
                ) : (
                    // Plain text nodes only: notes are never interpreted as markup.
                    <motion.div
                        className="relative overflow-hidden"
                        initial={false}
                        animate={{ height: noteHeight }}
                        transition={{ duration: reduceMotion ? 0 : 0.25, ease: "easeOut" }}
                    >
                        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                            <motion.div
                                key={active.id}
                                ref={activeNoteRef}
                                custom={direction}
                                variants={reduceMotion ? reducedNoteVariants : noteVariants}
                                initial="enter"
                                animate="center"
                                exit="exit"
                                transition={{
                                    duration: reduceMotion ? 0.1 : 0.25,
                                    ease: "easeOut",
                                }}
                                className="flex flex-col gap-2 will-change-transform"
                            >
                                <p className="text-sm/5 whitespace-pre-line text-note-foreground">
                                    {active.body}
                                </p>
                                <p className="text-sm/5 text-note-muted-foreground">
                                    — {active.name ?? "Anonymous"}
                                </p>
                            </motion.div>
                        </AnimatePresence>
                    </motion.div>
                )}
            </CardHeader>
            <CardFooter className="flex-wrap justify-between gap-2">
                {trigger}
                <div className="ml-auto flex gap-1" role="group" aria-label="Notes carousel">
                    <Button
                        variant="ghost"
                        size="icon-carousel"
                        className="size-11 lg:size-11"
                        disabled={displayNotes.length < 2}
                        aria-label="Previous note"
                        title={displayNotes.length === 0 ? "No notes yet" : undefined}
                        onClick={() => step(-1)}
                    >
                        <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-carousel"
                        className="size-11 lg:size-11"
                        disabled={displayNotes.length < 2}
                        aria-label="Next note"
                        title={displayNotes.length === 0 ? "No notes yet" : undefined}
                        onClick={() => step(1)}
                    >
                        <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
                    </Button>
                </div>
            </CardFooter>
        </Card>
    );

    const composer = (
        <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <FieldGroup>
                <Field>
                    <FieldLabel htmlFor={nameId}>Name (optional)</FieldLabel>
                    <Input
                        id={nameId}
                        autoComplete="nickname"
                        maxLength={NOTE_NAME_MAX}
                        disabled={busy}
                        placeholder="How should your note be signed?"
                        value={name}
                        onChange={(event) => {
                            setName(event.target.value);
                            editDraft();
                        }}
                    />
                </Field>
                <Field>
                    <div className="flex items-center justify-between gap-3">
                        <FieldLabel htmlFor={noteId}>Your note</FieldLabel>
                        <span id={countId} className="text-sm text-muted-foreground">
                            {note.length} / {NOTE_LIMIT}
                        </span>
                    </div>
                    <Textarea
                        id={noteId}
                        className="h-33 resize-none"
                        placeholder="Leave a thought or say hello…"
                        maxLength={NOTE_LIMIT}
                        disabled={busy}
                        value={note}
                        onChange={(event) => {
                            setNote(event.target.value);
                            editDraft();
                        }}
                        aria-describedby={`${countId} ${unavailableId}`}
                    />
                </Field>
            </FieldGroup>
            {COMPOSER_ENABLED && TURNSTILE_SITE_KEY !== undefined ? (
                <TurnstileChallenge key={attempt} siteKey={TURNSTILE_SITE_KEY} onToken={setToken} />
            ) : null}
            <p role="status" aria-live="polite" className="text-sm/5 text-muted-foreground">
                {feedback}
            </p>
            <ResponsiveDialogFooter>
                {COMPOSER_ENABLED ? (
                    <Button
                        type="submit"
                        variant="secondary"
                        className="h-11 w-full"
                        disabled={busy || invalid || submitState === "sent"}
                    >
                        {busy
                            ? "Sending…"
                            : submitState === "sent"
                              ? "Sent for review."
                              : "Post note"}
                    </Button>
                ) : (
                    <Button
                        type="button"
                        variant="secondary"
                        className="h-11 w-full"
                        disabled
                        aria-describedby={unavailableId}
                    >
                        Post note
                    </Button>
                )}
            </ResponsiveDialogFooter>
        </form>
    );

    return (
        <ResponsiveDialog
            open={composerOpen}
            onOpenChange={setComposerOpen}
            title="Add a note"
            description={description}
            className="px-4 sm:px-6"
            trigger={
                <Button variant="ghost" className="h-11 gap-2 px-1">
                    <HugeiconsIcon
                        icon={PlusSignIcon}
                        data-icon="inline-start"
                        aria-hidden="true"
                    />
                    Add a note
                </Button>
            }
            triggerHost={(trigger) => noteCard(trigger)}
            headerAction={
                <ResponsiveClose>
                    <Button
                        variant="ghost"
                        size="icon-carousel"
                        className="size-11 lg:size-11"
                        aria-label="Close note dialog"
                    >
                        <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
                    </Button>
                </ResponsiveClose>
            }
        >
            {composer}
        </ResponsiveDialog>
    );
}

export function VisitorNotes({ initial }: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <VisitorNotesContent initial={initial} />
        </SharedAtomRegistry>
    );
}
