/** @jsxImportSource react */
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
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@artisann-port/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@artisann-port/ui/components/field";
import { Input } from "@artisann-port/ui/components/input";
import { Textarea } from "@artisann-port/ui/components/textarea";
import { useAtomSet } from "@effect/atom-react";
import { HugeiconsIcon } from "@hugeicons/react";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
    Cancel01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    PlusSignIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { useEffect, useId, useRef, useState, type ComponentRef } from "react";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";
import { NotesClient } from "@/lib/rpc-client";

const NOTE_LIMIT = NOTE_BODY_MAX;
const LOCAL_NOTES_KEY = "artisann:visitor-notes";
const LocalNote = Schema.Struct({
    id: VisitorNote.fields.id,
    name: VisitorNote.fields.name,
    body: VisitorNote.fields.body,
    submittedAt: VisitorNote.fields.submittedAt,
});
type LocalNote = typeof LocalNote.Type;
const decodeLocalNotes = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(LocalNote)));

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

        const render = () => {
            if (widgetId !== null || window.turnstile === undefined) return;
            const isLocal =
                window.location.hostname === "localhost" ||
                window.location.hostname === "127.0.0.1";
            const effectiveSiteKey = isLocal ? "1x00000000000000000000AA" : siteKey;
            widgetId = window.turnstile.render(container, {
                sitekey: effectiveSiteKey,
                action: TURNSTILE_ACTION,
                callback: (token) => onToken(token),
                "expired-callback": () => onToken(null),
                "error-callback": () => onToken(null),
            });
            if (isLocal && widgetId) {
                // Automatically acquire token for local development testing
                onToken("XXXX.DUMMY.TOKEN.XXXX");
            }
        };

        if (window.turnstile !== undefined && "ready" in window.turnstile) {
            window.turnstile.ready(render);
        } else {
            const poll = () => {
                if (destroyed) return;
                if (window.turnstile !== undefined && "ready" in window.turnstile) {
                    window.turnstile.ready(render);
                } else {
                    requestAnimationFrame(poll);
                }
            };
            requestAnimationFrame(poll);
        }

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
    const [localNotes, setLocalNotes] = useState<readonly LocalNote[]>([]);
    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(LOCAL_NOTES_KEY);
            if (stored === null) return;
            const decoded = decodeLocalNotes(stored);
            if (Option.isSome(decoded)) setLocalNotes(decoded.value);
        } catch {
            // Storage may be blocked; notes submitted this visit still appear immediately.
        }
    }, []);
    const allNotes = [
        ...localNotes.filter((localNote) => !notes.some((note) => note.id === localNote.id)),
        ...notes,
    ];
    // An approved note becomes server-authoritative under the same id. Prune the
    // local copy and persist the reduction: otherwise an owner deletion leaves no
    // server note, and a reload would resurrect the stale local record.
    useEffect(() => {
        if (notes.length === 0) return;
        setLocalNotes((previous) => {
            const remaining = previous.filter(
                (localNote) => !notes.some((note) => note.id === localNote.id),
            );
            if (remaining.length === previous.length) return previous;
            try {
                window.localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(remaining));
            } catch {
                // Storage may be blocked; the in-memory reduction still applies.
            }
            return remaining;
        });
    }, [notes]);
    const submitNote = useAtomSet(NotesClient.mutation("notes.submit"), {
        mode: "promiseExit",
    });

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const activeIndex = Math.max(
        0,
        allNotes.findIndex((note) => note.id === selectedId),
    );
    const active = allNotes[activeIndex];

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

    const step = (delta: number) => {
        const next = allNotes[(activeIndex + delta + allNotes.length) % allNotes.length];
        if (next !== undefined) setSelectedId(next.id);
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
        const nextLocalNotes = [
            submitted,
            ...localNotes.filter((localNote) => localNote.id !== id),
        ];
        setLocalNotes(nextLocalNotes);
        setSelectedId(id);
        try {
            window.localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(nextLocalNotes));
        } catch {
            // A storage failure must not hide an accepted note from this visit.
        }
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

    return (
        <Dialog>
            <Card
                variant="note"
                role="region"
                aria-labelledby={`${id}-heading`}
                data-portfolio-section="visitor-notes"
                className="relative min-h-52.25 gap-3 overflow-hidden"
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
                            <br />
                            Be the first to leave one.
                        </CardDescription>
                    ) : (
                        // Plain text nodes only: notes are never interpreted as markup.
                        <div className="flex flex-col gap-2">
                            <p className="text-sm/5 whitespace-pre-line text-note-foreground">
                                {active.body}
                            </p>
                            <p className="text-sm/5 text-note-muted-foreground">
                                — {active.name ?? "Anonymous"}
                            </p>
                        </div>
                    )}
                </CardHeader>
                <CardFooter className="flex-wrap justify-between gap-2">
                    <DialogTrigger render={<Button variant="ghost" className="h-11 gap-2 px-1" />}>
                        <HugeiconsIcon
                            icon={PlusSignIcon}
                            data-icon="inline-start"
                            aria-hidden="true"
                        />
                        Add a note
                    </DialogTrigger>
                    <div className="ml-auto flex gap-1" role="group" aria-label="Notes carousel">
                        <Button
                            variant="ghost"
                            size="icon-carousel"
                            className="size-11 lg:size-11"
                            disabled={allNotes.length < 2}
                            aria-label="Previous note"
                            title={allNotes.length === 0 ? "No notes yet" : undefined}
                            onClick={() => step(-1)}
                        >
                            <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-carousel"
                            className="size-11 lg:size-11"
                            disabled={allNotes.length < 2}
                            aria-label="Next note"
                            title={allNotes.length === 0 ? "No notes yet" : undefined}
                            onClick={() => step(1)}
                        >
                            <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
                        </Button>
                    </div>
                </CardFooter>
            </Card>
            <DialogContent showCloseButton={false}>
                <DialogHeader>
                    <div className="flex min-h-11 items-center justify-between gap-3">
                        <DialogTitle>Add a note</DialogTitle>
                        <DialogClose
                            render={
                                <Button
                                    variant="ghost"
                                    size="icon-carousel"
                                    className="size-11 lg:size-11"
                                    aria-label="Close note dialog"
                                />
                            }
                        >
                            <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
                        </DialogClose>
                    </div>
                    <DialogDescription id={unavailableId}>
                        {COMPOSER_ENABLED
                            ? "Your note will be public after approval. Please keep it kind."
                            : "Posting is not available yet."}
                    </DialogDescription>
                </DialogHeader>
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
                        <TurnstileChallenge
                            key={attempt}
                            siteKey={TURNSTILE_SITE_KEY}
                            onToken={setToken}
                        />
                    ) : null}
                    <p role="status" aria-live="polite" className="text-sm/5 text-muted-foreground">
                        {feedback}
                    </p>
                    <DialogFooter>
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
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function VisitorNotes({ initial }: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <VisitorNotesContent initial={initial} />
        </SharedAtomRegistry>
    );
}
