import {
    normalizeNoteName,
    normalizeNoteText,
    SiteContent,
    VisitorNote,
} from "@artisann-port/portfolio-domain/content";
import {
    NOTE_BODY_MAX,
    NOTE_NAME_MAX,
    NoteSubmission,
    NoteSubmissionId,
    newSubmissionId,
    TURNSTILE_ACTION,
} from "@artisann-port/presence/notes";
import {
    Cancel01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    PlusSignIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { DateTime, Effect, Option, Queue, Random, Schema, Stream } from "effect";
import { Command, Dom, Mount, Render, Submodel, Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { HtmlBuilder } from "foldkit/html";
import { PortfolioHttp } from "../lib/api-client.ts";
import { reconcileOrder } from "../lib/shuffle.ts";

const LOCAL_NOTES_KEY = "artisann:visitor-notes";
const DIALOG_ID = "portfolio-note-composer";
const Placement = Schema.Literals(["desktop", "mobile"]);
const LocalNote = Schema.Struct({
    id: VisitorNote.fields.id,
    name: VisitorNote.fields.name,
    body: VisitorNote.fields.body,
    submittedAt: VisitorNote.fields.submittedAt,
});
type LocalNote = typeof LocalNote.Type;
const Retry = Schema.Struct({ id: NoteSubmissionId, payload: Schema.String });
const decodeStoredNotes = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Array(LocalNote)),
);

export const Model = Schema.Struct({
    approved: Schema.Array(VisitorNote),
    local: Schema.Array(LocalNote),
    order: Schema.Array(Schema.String),
    selectedId: Schema.NullOr(Schema.String),
    localLoaded: Schema.Boolean,
    siteKey: Schema.String,
    enabled: Schema.Boolean,
    composerPlacement: Schema.NullOr(Placement),
    name: Schema.String,
    body: Schema.String,
    retry: Schema.NullOr(Retry),
    submission: Schema.NullOr(NoteSubmission),
    submitState: Schema.Literals(["idle", "submitting", "sent", "failed"]),
    feedback: Schema.String,
    token: Schema.NullOr(Schema.String),
    challengeGeneration: Schema.Number,
    direction: Schema.Literals([-1, 1]),
    heights: Schema.Struct({
        desktop: Schema.NullOr(Schema.Number),
        mobile: Schema.NullOr(Schema.Number),
    }),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
    ReceivedContent: { content: SiteContent },
    ReceivedLocalNotes: {
        notes: Schema.Array(LocalNote),
        order: Schema.Array(Schema.String),
    },
    CompletedPersistence: {},
    ClickedPrevious: {},
    ClickedNext: {},
    OpenedComposer: { placement: Placement },
    ClosedComposer: { placement: Placement },
    CompletedOpenDialog: { placement: Placement, opened: Schema.Boolean },
    ChangedName: { value: Schema.String },
    ChangedBody: { value: Schema.String },
    ReceivedToken: { generation: Schema.Number, token: Schema.NullOr(Schema.String) },
    ClickedSubmit: {},
    PreparedSubmission: { submission: NoteSubmission, payload: Schema.String },
    SucceededSubmission: { submission: NoteSubmission, submittedAt: LocalNote.fields.submittedAt },
    FailedSubmission: { id: NoteSubmissionId },
    MeasuredNote: { placement: Placement, id: Schema.String, height: Schema.Number },
});
export type Message = typeof Message.Type;

export interface ViewInputs {
    readonly placement: "desktop" | "mobile";
}

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

function readLocalNotes(): readonly LocalNote[] {
    if (!("window" in globalThis)) return [];
    try {
        const stored = window.localStorage.getItem(LOCAL_NOTES_KEY);
        if (stored === null) return [];
        return Option.getOrElse(decodeStoredNotes(stored), () => []);
    } catch {
        // Blocked browser storage must not disable notes for the current visit.
        return [];
    }
}

const PersistNotes = Command.define("Notes.PersistNotes", {
    args: { notes: Schema.Array(LocalNote) },
    messages: [Message.CompletedPersistence],
    execute: ({ notes }) =>
        Effect.sync(() => {
            if ("window" in globalThis) {
                try {
                    window.localStorage.setItem(LOCAL_NOTES_KEY, JSON.stringify(notes));
                } catch {
                    try {
                        // A stale approved copy must not reappear after an owner removes it.
                        window.localStorage.removeItem(LOCAL_NOTES_KEY);
                    } catch {
                        // The shared Model remains authoritative for this visit without storage.
                    }
                }
            }
            return Message.CompletedPersistence();
        }),
});

const LoadNotes = Command.define("Notes.LoadNotes", {
    args: { approved: Schema.Array(VisitorNote) },
    messages: [Message.ReceivedLocalNotes],
    execute: ({ approved }) =>
        Effect.gen(function* () {
            const notes = yield* Effect.sync(readLocalNotes);
            const approvedIds = new Set(approved.map((note) => note.id));
            const ids = [
                ...notes.filter((note) => !approvedIds.has(note.id)).map((note) => note.id),
                ...approved.map((note) => note.id),
            ];
            const order = yield* Random.shuffle(ids);
            return Message.ReceivedLocalNotes({ notes, order });
        }),
});

const PrepareSubmission = Command.define("Notes.PrepareSubmission", {
    args: {
        id: Schema.NullOr(NoteSubmissionId),
        name: NoteSubmission.fields.name,
        body: NoteSubmission.fields.body,
        token: Schema.String,
        payload: Schema.String,
    },
    messages: [Message.PreparedSubmission],
    execute: ({ id, name, body, token, payload }) =>
        Effect.sync(() =>
            Message.PreparedSubmission({
                submission: { id: id ?? newSubmissionId(), name, body, turnstileToken: token },
                payload,
            }),
        ),
});

const SubmitNote = Command.define("Notes.SubmitNote", {
    args: { submission: NoteSubmission },
    messages: [Message.SucceededSubmission, Message.FailedSubmission],
    execute: ({ submission }) =>
        Effect.gen(function* () {
            const http = yield* PortfolioHttp;
            return yield* http.submitNote(submission).pipe(
                Effect.match({
                    onFailure: () => Message.FailedSubmission({ id: submission.id }),
                    onSuccess: (accepted) =>
                        accepted.status === "pending" && accepted.id === submission.id
                            ? Message.SucceededSubmission({
                                  submission,
                                  submittedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                              })
                            : Message.FailedSubmission({ id: submission.id }),
                }),
            );
        }),
});

const OpenDialog = Command.define("Notes.OpenDialog", {
    args: { placement: Placement },
    messages: [Message.CompletedOpenDialog],
    execute: ({ placement }) =>
        Effect.gen(function* () {
            yield* Render.afterCommit;
            return yield* Effect.sync(() => {
                if (!("document" in globalThis)) {
                    return Message.CompletedOpenDialog({ placement, opened: false });
                }
                const dialog = document.getElementById(DIALOG_ID);
                if (!(dialog instanceof HTMLDialogElement)) {
                    return Message.CompletedOpenDialog({ placement, opened: false });
                }
                try {
                    if (!dialog.open) dialog.showModal();
                    return Message.CompletedOpenDialog({ placement, opened: true });
                } catch {
                    return Message.CompletedOpenDialog({ placement, opened: false });
                }
            });
        }),
});

export const init = (flags: {
    content: SiteContent;
    siteKey: string;
    enabled: boolean;
}): Update.Return<Model, Message, PortfolioHttp> => ({
    model: {
        approved: flags.content.notes,
        local: [],
        order: flags.content.notes.map((note) => note.id),
        selectedId: null,
        localLoaded: false,
        siteKey: flags.siteKey,
        enabled: flags.enabled && flags.siteKey.length > 0,
        composerPlacement: null,
        name: "",
        body: "",
        retry: null,
        submission: null,
        submitState: "idle",
        feedback: "",
        token: null,
        challengeGeneration: 0,
        direction: 1,
        heights: { desktop: null, mobile: null },
    },
    commands: [LoadNotes({ approved: flags.content.notes })],
});

function reconcile(model: Model): Model {
    const approvedIds = new Set(model.approved.map((note) => note.id));
    const local = model.local.filter((note) => !approvedIds.has(note.id));
    const next = { ...model, local };
    const order = reconcileOrder(
        model.order,
        [...local.map((note) => note.id), ...model.approved.map((note) => note.id)],
        (id) => id,
    );
    return {
        ...next,
        order,
        selectedId:
            model.selectedId !== null && order.includes(model.selectedId)
                ? model.selectedId
                : (order[0] ?? null),
    };
}

function editDraft(model: Model, name: string, body: string): Model {
    if (model.submitState === "submitting") return model;
    const payload = JSON.stringify({
        name: normalizeNoteName(name),
        body: normalizeNoteText(body),
    });
    return {
        ...model,
        name,
        body,
        retry: model.retry?.payload === payload ? model.retry : null,
        submitState: "idle",
        feedback: "",
    };
}

function step(model: Model, delta: -1 | 1): Model {
    if (model.order.length < 2) return model;
    const index = Math.max(
        0,
        model.order.findIndex((id) => id === model.selectedId),
    );
    return {
        ...model,
        selectedId: model.order[(index + delta + model.order.length) % model.order.length] ?? null,
        direction: delta,
    };
}

export const update = (
    model: Model,
    message: Message,
): Update.Return<Model, Message, PortfolioHttp> =>
    Message.match<Update.Return<Model, Message, PortfolioHttp>>(message, {
        ReceivedContent: ({ content }) => {
            const next = reconcile({ ...model, approved: content.notes });
            return {
                model: next,
                commands:
                    model.localLoaded && next.local.length !== model.local.length
                        ? [PersistNotes({ notes: next.local })]
                        : [],
            };
        },
        ReceivedLocalNotes: ({ notes, order }) => {
            if (model.localLoaded) return { model };
            const local = [
                ...model.local,
                ...notes.filter((note) => !model.local.some((current) => current.id === note.id)),
            ];
            const next = reconcile({ ...model, local, order, localLoaded: true });
            return { model: next, commands: [PersistNotes({ notes: next.local })] };
        },
        CompletedPersistence: () => ({ model }),
        ClickedPrevious: () => ({ model: step(model, -1) }),
        ClickedNext: () => ({ model: step(model, 1) }),
        OpenedComposer: ({ placement }) =>
            model.composerPlacement !== null
                ? { model }
                : {
                      model: {
                          ...model,
                          composerPlacement: placement,
                          token: null,
                          challengeGeneration: model.challengeGeneration + 1,
                      },
                      commands: [OpenDialog({ placement })],
                  },
        ClosedComposer: ({ placement }) => ({
            model:
                model.composerPlacement === placement
                    ? {
                          ...model,
                          composerPlacement: null,
                          token: null,
                          challengeGeneration: model.challengeGeneration + 1,
                      }
                    : model,
        }),
        CompletedOpenDialog: ({ placement, opened }) => ({
            model:
                !opened && model.composerPlacement === placement
                    ? { ...model, composerPlacement: null, token: null }
                    : model,
        }),
        ChangedName: ({ value }) => ({
            model: editDraft(model, value.slice(0, NOTE_NAME_MAX), model.body),
        }),
        ChangedBody: ({ value }) => ({
            model: editDraft(model, model.name, value.slice(0, NOTE_BODY_MAX)),
        }),
        ReceivedToken: ({ generation, token }) => ({
            model:
                generation === model.challengeGeneration &&
                model.composerPlacement !== null &&
                model.submitState !== "submitting"
                    ? { ...model, token }
                    : model,
        }),
        ClickedSubmit: () => {
            if (
                !model.enabled ||
                model.composerPlacement === null ||
                model.submitState === "submitting" ||
                model.submitState === "sent"
            )
                return { model };
            const name = normalizeNoteName(model.name);
            const body = normalizeNoteText(model.body);
            if (
                body === null ||
                body.length > NOTE_BODY_MAX ||
                (name?.length ?? 0) > NOTE_NAME_MAX
            ) {
                return { model };
            }
            if (model.token === null)
                return {
                    model: {
                        ...model,
                        submitState: "failed",
                        feedback: "Finish the verification first, then send your note.",
                    },
                };
            const payload = JSON.stringify({ name, body });
            return {
                model: { ...model, submitState: "submitting", feedback: "", token: null },
                commands: [
                    PrepareSubmission({
                        id: model.retry?.payload === payload ? model.retry.id : null,
                        name,
                        body,
                        token: model.token,
                        payload,
                    }),
                ],
            };
        },
        PreparedSubmission: ({ submission, payload }) =>
            model.submitState !== "submitting" || model.submission !== null
                ? { model }
                : {
                      model: { ...model, retry: { id: submission.id, payload }, submission },
                      commands: [SubmitNote({ submission })],
                  },
        SucceededSubmission: ({ submission, submittedAt }) => {
            if (model.submission?.id !== submission.id) return { model };
            const localNote = {
                id: submission.id,
                name: submission.name,
                body: submission.body,
                submittedAt,
            };
            const next = reconcile({
                ...model,
                local: [localNote, ...model.local.filter((note) => note.id !== submission.id)],
                selectedId: submission.id,
                submission: null,
                submitState: "sent",
                feedback: "Shown here and sent for review. It will be public after approval.",
                token: null,
                challengeGeneration: model.challengeGeneration + 1,
            });
            return { model: next, commands: [PersistNotes({ notes: next.local })] };
        },
        FailedSubmission: ({ id }) => ({
            model:
                model.submission?.id === id
                    ? {
                          ...model,
                          submission: null,
                          submitState: "failed",
                          feedback: "Sending failed. Your note is still here — please try again.",
                          token: null,
                          challengeGeneration: model.challengeGeneration + 1,
                      }
                    : model,
        }),
        MeasuredNote: ({ placement, id, height }) => ({
            model:
                (model.selectedId ?? model.order[0]) === id && model.heights[placement] !== height
                    ? { ...model, heights: { ...model.heights, [placement]: height } }
                    : model,
        }),
    });

const Challenge = Mount.defineStream("Notes.Challenge", {
    args: { siteKey: Schema.String, generation: Schema.Number },
    messages: [Message.ReceivedToken],
    execute: ({ element, siteKey, generation }) =>
        Stream.callback<typeof Message.ReceivedToken.Type>((queue) =>
            Effect.gen(function* () {
                yield* Effect.acquireRelease(
                    Effect.sync(() => {
                        let active = true;
                        let widgetId: string | null = null;
                        let timer: number | undefined;
                        const emit = (token: string | null) => {
                            if (active)
                                Queue.offerUnsafe(
                                    queue,
                                    Message.ReceivedToken({ generation, token }),
                                );
                        };
                        const render = () => {
                            if (!active || widgetId !== null || !(element instanceof HTMLElement))
                                return;
                            const api = window.turnstile;
                            if (api === undefined) return;
                            try {
                                widgetId = api.render(element, {
                                    sitekey: siteKey,
                                    action: TURNSTILE_ACTION,
                                    callback: emit,
                                    "expired-callback": () => emit(null),
                                    "error-callback": () => emit(null),
                                });
                            } catch {
                                emit(null);
                            }
                        };
                        const tick = () => {
                            if (!active || widgetId !== null) return;
                            const api = window.turnstile;
                            if (api !== undefined) {
                                try {
                                    api.ready(render);
                                } catch {
                                    render();
                                }
                            }
                            if (active && widgetId === null) timer = window.setTimeout(tick, 100);
                        };
                        tick();
                        return () => {
                            active = false;
                            window.clearTimeout(timer);
                            if (widgetId !== null) {
                                try {
                                    window.turnstile?.remove(widgetId);
                                } catch {
                                    // A third-party teardown failure must not keep the modal open.
                                }
                            }
                        };
                    }),
                    (cleanup) => Effect.sync(cleanup),
                );
                return yield* Effect.never;
            }),
        ),
});

function restoreTrigger(placement: ViewInputs["placement"]): void {
    const preferred = document.getElementById(`portfolio-note-trigger-${placement}`);
    const other = document.getElementById(
        `portfolio-note-trigger-${placement === "desktop" ? "mobile" : "desktop"}`,
    );
    const target =
        preferred instanceof HTMLElement && preferred.getClientRects().length > 0
            ? preferred
            : other;
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

const DialogLifecycle = Mount.defineStream("Notes.DialogLifecycle", {
    args: { placement: Placement },
    messages: [Message.ClosedComposer],
    execute: ({ element, placement }) =>
        Stream.callback<typeof Message.ClosedComposer.Type>((queue) =>
            Effect.gen(function* () {
                yield* Effect.acquireRelease(
                    Effect.gen(function* () {
                        const cleanup = yield* Effect.sync(() => {
                            if (!(element instanceof HTMLDialogElement)) return () => {};
                            document.body.appendChild(element);
                            const close = () =>
                                Queue.offerUnsafe(queue, Message.ClosedComposer({ placement }));
                            const cancel = (event: Event) => {
                                event.preventDefault();
                                close();
                            };
                            const backdrop = (event: MouseEvent) => {
                                if (event.target !== element) return;
                                const rect = element.getBoundingClientRect();
                                if (
                                    event.clientX < rect.left ||
                                    event.clientX > rect.right ||
                                    event.clientY < rect.top ||
                                    event.clientY > rect.bottom
                                )
                                    close();
                            };
                            let drag: { id: number; y: number; startedAt: number } | null = null;
                            const handle = element.querySelector("[data-notes-drag-handle]");
                            const down = (event: PointerEvent) => {
                                if (
                                    !window.matchMedia("(max-width: 63.999rem)").matches ||
                                    event.button !== 0
                                )
                                    return;
                                drag = {
                                    id: event.pointerId,
                                    y: event.clientY,
                                    startedAt: event.timeStamp,
                                };
                                if (handle instanceof HTMLElement)
                                    handle.setPointerCapture(event.pointerId);
                            };
                            const move = (event: PointerEvent) => {
                                if (drag?.id !== event.pointerId) return;
                                element.style.setProperty(
                                    "--notes-drawer-offset",
                                    `${Math.max(0, event.clientY - drag.y)}px`,
                                );
                            };
                            const up = (event: PointerEvent) => {
                                if (drag?.id !== event.pointerId) return;
                                const distance = event.clientY - drag.y;
                                const elapsed = Math.max(1, event.timeStamp - drag.startedAt);
                                drag = null;
                                element.style.removeProperty("--notes-drawer-offset");
                                if (distance > 80 || (distance > 24 && distance / elapsed > 0.5))
                                    close();
                            };
                            const cancelled = () => {
                                drag = null;
                                element.style.removeProperty("--notes-drawer-offset");
                            };
                            element.addEventListener("cancel", cancel);
                            element.addEventListener("close", close);
                            element.addEventListener("click", backdrop);
                            if (handle instanceof HTMLElement) {
                                handle.addEventListener("pointerdown", down);
                                handle.addEventListener("pointermove", move);
                                handle.addEventListener("pointerup", up);
                                handle.addEventListener("pointercancel", cancelled);
                            }
                            return () => {
                                element.removeEventListener("cancel", cancel);
                                element.removeEventListener("close", close);
                                element.removeEventListener("click", backdrop);
                                if (handle instanceof HTMLElement) {
                                    handle.removeEventListener("pointerdown", down);
                                    handle.removeEventListener("pointermove", move);
                                    handle.removeEventListener("pointerup", up);
                                    handle.removeEventListener("pointercancel", cancelled);
                                }
                                if (element.open) element.close();
                                element.remove();
                                restoreTrigger(placement);
                            };
                        });
                        yield* Dom.lockScroll;
                        return cleanup;
                    }),
                    (cleanup) =>
                        Effect.gen(function* () {
                            yield* Effect.sync(cleanup);
                            yield* Dom.unlockScroll;
                        }),
                );
                return yield* Effect.never;
            }),
        ),
});

const ObserveNote = Mount.defineStream("Notes.ObserveNote", {
    args: { placement: Placement, id: Schema.String },
    messages: [Message.MeasuredNote],
    execute: ({ element, placement, id }) =>
        Stream.callback<typeof Message.MeasuredNote.Type>((queue) =>
            Effect.gen(function* () {
                yield* Effect.acquireRelease(
                    Effect.sync(() => {
                        const measure = () =>
                            Queue.offerUnsafe(
                                queue,
                                Message.MeasuredNote({
                                    placement,
                                    id,
                                    height: element.getBoundingClientRect().height,
                                }),
                            );
                        measure();
                        const observer = new ResizeObserver(measure);
                        observer.observe(element);
                        return observer;
                    }),
                    (observer) => Effect.sync(() => observer.disconnect()),
                );
                return yield* Effect.never;
            }),
        ),
});

const BUTTON =
    "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[transform,translate,opacity,color,background-color,border-color,box-shadow] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const GHOST =
    "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50";
const CAROUSEL = "size-11 rounded-xl lg:size-11 [&_svg:not([class*='size-'])]:size-4.5";
const FIELD =
    "group/field flex w-full gap-2 data-[invalid=true]:text-destructive flex-col *:w-full [&>.sr-only]:w-auto";
const LABEL =
    "flex items-center text-sm font-medium select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group/field-label peer/field-label w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50";
const INPUT =
    "h-11 w-full min-w-0 rounded-lg border border-transparent bg-muted px-3 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";
const TEXTAREA =
    "flex min-h-16 w-full rounded-lg border border-transparent bg-muted p-3 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 h-33 resize-none";

function icon(h: HtmlBuilder<Message>, paths: typeof PlusSignIcon, inline = false) {
    return h.svg(
        [
            h.Attribute("viewBox", "0 0 24 24"),
            h.Attribute("width", "24"),
            h.Attribute("height", "24"),
            h.Attribute("fill", "none"),
            h.AriaHidden(true),
            ...(inline ? [h.DataAttribute("icon", "inline-start")] : []),
        ],
        paths.map(([, attributes]) =>
            h.path(
                Object.entries(attributes).map(([name, value]) =>
                    name === "key"
                        ? h.Key(String(value))
                        : h.Attribute(
                              name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
                              String(value),
                          ),
                ),
            ),
        ),
    );
}

function composer(model: Model, placement: ViewInputs["placement"], h: HtmlBuilder<Message>) {
    const nameId = `${DIALOG_ID}-name`;
    const bodyId = `${DIALOG_ID}-body`;
    const countId = `${DIALOG_ID}-count`;
    const descriptionId = `${DIALOG_ID}-description`;
    const busy = model.submitState === "submitting";
    const body = normalizeNoteText(model.body);
    const invalid =
        body === null ||
        body.length > NOTE_BODY_MAX ||
        (normalizeNoteName(model.name)?.length ?? 0) > NOTE_NAME_MAX ||
        model.token === null;
    return h.dialog(
        [
            h.Id(DIALOG_ID),
            h.Class(
                "portfolio-notes-dialog bg-popover text-sm text-popover-foreground ring-1 ring-border outline-none px-4 sm:px-6",
            ),
            h.AriaLabelledBy(`${DIALOG_ID}-title`),
            h.AriaDescribedBy(descriptionId),
            h.OnMount(DialogLifecycle({ placement })),
        ],
        [
            h.div([
                h.Class(
                    "portfolio-notes-drag-handle mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30",
                ),
                h.DataAttribute("notes-drag-handle", ""),
                h.AriaHidden(true),
            ]),
            h.div(
                [h.Class("flex flex-col gap-2")],
                [
                    h.div(
                        [h.Class("flex min-h-11 items-center justify-between gap-3")],
                        [
                            h.h2(
                                [
                                    h.Id(`${DIALOG_ID}-title`),
                                    h.Class("font-heading text-xl leading-[1.3] font-semibold"),
                                ],
                                ["Add a note"],
                            ),
                            h.button(
                                [
                                    h.Type("button"),
                                    h.Class(`${BUTTON} ${GHOST} ${CAROUSEL}`),
                                    h.AriaLabel("Close note dialog"),
                                    h.OnClick(Message.ClosedComposer({ placement })),
                                ],
                                [icon(h, Cancel01Icon)],
                            ),
                        ],
                    ),
                    h.p(
                        [
                            h.Id(descriptionId),
                            h.Class(
                                "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
                            ),
                        ],
                        [
                            model.enabled
                                ? "Your note will be public after approval. Please keep it kind."
                                : "Posting is not available yet.",
                        ],
                    ),
                ],
            ),
            h.div(
                [h.Class("flex min-h-0 flex-col gap-4")],
                [
                    h.form(
                        [h.Class("flex flex-col gap-4"), h.OnSubmit(Message.ClickedSubmit())],
                        [
                            h.div(
                                [
                                    h.DataAttribute("slot", "field-group"),
                                    h.Class(
                                        "group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
                                    ),
                                ],
                                [
                                    h.div(
                                        [
                                            h.Class(FIELD),
                                            h.Role("group"),
                                            h.DataAttribute("slot", "field"),
                                        ],
                                        [
                                            h.label(
                                                [h.For(nameId), h.Class(LABEL)],
                                                ["Name (optional)"],
                                            ),
                                            h.input([
                                                h.Id(nameId),
                                                h.Class(INPUT),
                                                h.DataAttribute("slot", "input"),
                                                h.Attribute("autocomplete", "nickname"),
                                                h.Attribute("maxlength", String(NOTE_NAME_MAX)),
                                                h.Disabled(busy),
                                                h.Placeholder("How should your note be signed?"),
                                                h.Value(model.name),
                                                h.OnInput((value) =>
                                                    Message.ChangedName({ value }),
                                                ),
                                            ]),
                                        ],
                                    ),
                                    h.div(
                                        [
                                            h.Class(FIELD),
                                            h.Role("group"),
                                            h.DataAttribute("slot", "field"),
                                        ],
                                        [
                                            h.div(
                                                [
                                                    h.Class(
                                                        "flex items-center justify-between gap-3",
                                                    ),
                                                ],
                                                [
                                                    h.label(
                                                        [h.For(bodyId), h.Class(LABEL)],
                                                        ["Your note"],
                                                    ),
                                                    h.span(
                                                        [
                                                            h.Id(countId),
                                                            h.Class(
                                                                "text-sm text-muted-foreground",
                                                            ),
                                                        ],
                                                        [`${model.body.length} / ${NOTE_BODY_MAX}`],
                                                    ),
                                                ],
                                            ),
                                            h.textarea([
                                                h.Id(bodyId),
                                                h.Class(TEXTAREA),
                                                h.DataAttribute("slot", "textarea"),
                                                h.Placeholder("Leave a thought or say hello…"),
                                                h.Attribute("maxlength", String(NOTE_BODY_MAX)),
                                                h.Disabled(busy),
                                                h.Value(model.body),
                                                h.OnInput((value) =>
                                                    Message.ChangedBody({ value }),
                                                ),
                                                h.AriaDescribedBy(`${countId} ${descriptionId}`),
                                            ]),
                                        ],
                                    ),
                                ],
                            ),
                            model.enabled
                                ? h.keyed("div")(`challenge-${model.challengeGeneration}`, [
                                      h.Class("flex justify-center"),
                                      h.OnMount(
                                          Challenge({
                                              siteKey: model.siteKey,
                                              generation: model.challengeGeneration,
                                          }),
                                      ),
                                  ])
                                : null,
                            h.p(
                                [
                                    h.Role("status"),
                                    h.AriaLive("polite"),
                                    h.Class("text-sm/5 text-muted-foreground"),
                                ],
                                [model.feedback],
                            ),
                            h.div(
                                [h.Class("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end")],
                                [
                                    h.button(
                                        [
                                            h.Type("submit"),
                                            h.Class(
                                                `${BUTTON} bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground h-11 w-full gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2`,
                                            ),
                                            h.Disabled(
                                                !model.enabled ||
                                                    busy ||
                                                    invalid ||
                                                    model.submitState === "sent",
                                            ),
                                            h.AriaDescribedBy(descriptionId),
                                        ],
                                        [
                                            busy
                                                ? "Sending…"
                                                : model.submitState === "sent"
                                                  ? "Sent for review."
                                                  : "Post note",
                                        ],
                                    ),
                                ],
                            ),
                        ],
                    ),
                ],
            ),
        ],
    );
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { placement }, h) => {
    const headingId = `portfolio-notes-${placement}-heading`;
    const activeId = model.selectedId ?? model.order[0];
    const active =
        model.approved.find((note) => note.id === activeId) ??
        model.local.find((note) => note.id === activeId);
    const height = model.heights[placement];
    return h.div(
        [h.Class("h-full")],
        [
            h.div(
                [
                    h.DataAttribute("slot", "card"),
                    h.DataAttribute("size", "default"),
                    h.DataAttribute("variant", "note"),
                    h.DataAttribute("portfolio-section", "visitor-notes"),
                    h.Role("region"),
                    h.AriaLabelledBy(headingId),
                    h.Class(
                        "group/card flex min-w-0 flex-col rounded-xl py-(--card-spacing) text-sm [--card-spacing:--spacing(5)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl bg-note text-note-foreground relative h-full min-h-52.25 gap-3 overflow-hidden",
                    ),
                ],
                [
                    h.span([
                        h.AriaHidden(true),
                        h.Class(
                            "pointer-events-none absolute top-0 right-0 size-5 bg-note-fold [clip-path:polygon(0_0,100%_100%,0_100%)]",
                        ),
                    ]),
                    h.div(
                        [
                            h.DataAttribute("slot", "card-header"),
                            h.Class(
                                "group/card-header @container/card-header auto-rows-min items-start rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing) flex flex-1 flex-col gap-2",
                            ),
                        ],
                        [
                            h.div(
                                [
                                    h.DataAttribute("slot", "card-title"),
                                    h.Class(
                                        "font-heading text-heading font-semibold group-data-[variant=note]/card:text-xl group-data-[variant=note]/card:leading-[1.3]",
                                    ),
                                ],
                                [h.h2([h.Id(headingId)], ["Leave a little note."])],
                            ),
                            active === undefined
                                ? h.div(
                                      [
                                          h.DataAttribute("slot", "card-description"),
                                          h.Class(
                                              "text-caption text-muted-foreground group-data-[variant=note]/card:text-sm/5 group-data-[variant=note]/card:text-note-muted-foreground",
                                          ),
                                      ],
                                      [
                                          "A thought, a hello, or something kind.",
                                          ...(model.localLoaded
                                              ? [h.br([]), "Be the first to leave one."]
                                              : []),
                                      ],
                                  )
                                : h.div(
                                      [
                                          h.Class(
                                              "portfolio-notes-height relative w-full overflow-hidden",
                                          ),
                                          h.Style({
                                              height: height === null ? "auto" : `${height}px`,
                                          }),
                                          h.AriaLive("polite"),
                                      ],
                                      [
                                          h.keyed("div")(
                                              active.id,
                                              [
                                                  h.Class(
                                                      "portfolio-note-transition flex flex-col gap-2 will-change-transform",
                                                  ),
                                                  h.DataAttribute(
                                                      "direction",
                                                      String(model.direction),
                                                  ),
                                                  h.OnMount(
                                                      ObserveNote({ placement, id: active.id }),
                                                  ),
                                              ],
                                              [
                                                  h.p(
                                                      [
                                                          h.Class(
                                                              "text-sm/5 whitespace-pre-line text-note-foreground",
                                                          ),
                                                      ],
                                                      [active.body],
                                                  ),
                                                  h.p(
                                                      [
                                                          h.Class(
                                                              "text-sm/5 text-note-muted-foreground",
                                                          ),
                                                      ],
                                                      [`— ${active.name ?? "Anonymous"}`],
                                                  ),
                                              ],
                                          ),
                                      ],
                                  ),
                        ],
                    ),
                    h.div(
                        [
                            h.DataAttribute("slot", "card-footer"),
                            h.Class(
                                "flex items-center px-(--card-spacing) flex-wrap justify-between gap-2",
                            ),
                        ],
                        [
                            h.button(
                                [
                                    h.Id(`portfolio-note-trigger-${placement}`),
                                    h.Type("button"),
                                    h.Class(
                                        `${BUTTON} ${GHOST} h-11 gap-2 px-1 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2`,
                                    ),
                                    h.AriaHasPopup("dialog"),
                                    h.AriaExpanded(model.composerPlacement === placement),
                                    h.OnClick(Message.OpenedComposer({ placement }), {
                                        focusSelector: `#portfolio-note-trigger-${placement}`,
                                    }),
                                ],
                                [icon(h, PlusSignIcon, true), "Add a note"],
                            ),
                            h.div(
                                [
                                    h.Class("ml-auto flex gap-1"),
                                    h.Role("group"),
                                    h.AriaLabel("Notes carousel"),
                                ],
                                [
                                    h.button(
                                        [
                                            h.Type("button"),
                                            h.Class(`${BUTTON} ${GHOST} ${CAROUSEL}`),
                                            h.Disabled(model.order.length < 2),
                                            h.AriaLabel("Previous note"),
                                            ...(model.order.length === 0
                                                ? [h.Title("No notes yet")]
                                                : []),
                                            h.OnClick(Message.ClickedPrevious()),
                                        ],
                                        [icon(h, ChevronLeftIcon)],
                                    ),
                                    h.button(
                                        [
                                            h.Type("button"),
                                            h.Class(`${BUTTON} ${GHOST} ${CAROUSEL}`),
                                            h.Disabled(model.order.length < 2),
                                            h.AriaLabel("Next note"),
                                            ...(model.order.length === 0
                                                ? [h.Title("No notes yet")]
                                                : []),
                                            h.OnClick(Message.ClickedNext()),
                                        ],
                                        [icon(h, ChevronRightIcon)],
                                    ),
                                ],
                            ),
                        ],
                    ),
                ],
            ),
            model.composerPlacement === placement ? composer(model, placement, h) : null,
        ],
    );
});

export const styles = `
.portfolio-notes-dialog {
    position: fixed;
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    max-height: 85dvh;
    margin: 0;
    border: 0;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-top: 0.75rem;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    transform: translateY(var(--notes-drawer-offset, 0px));
}
.portfolio-notes-dialog[open] { display: flex; flex-direction: column; gap: 0; animation: portfolio-notes-drawer-enter 300ms ease-out; }
.portfolio-notes-dialog::backdrop { background: rgb(0 0 0 / 0.5); }
.portfolio-notes-drag-handle { position: relative; touch-action: none; }
.portfolio-notes-drag-handle::before { content: ""; position: absolute; inset: -0.75rem -1rem; }
.portfolio-notes-height { transition: height 250ms ease-out; }
.portfolio-note-transition { animation: portfolio-note-enter 250ms ease-out both; }
.portfolio-note-transition[data-direction="-1"] { animation-name: portfolio-note-enter-previous; }
@keyframes portfolio-note-enter { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes portfolio-note-enter-previous { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes portfolio-notes-drawer-enter { from { transform: translateY(calc(100% + 2px)); } to { transform: translateY(0); } }
@keyframes portfolio-notes-dialog-enter { from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@media (min-width: 64rem) {
    .portfolio-notes-dialog { inset: 50% auto auto 50%; width: calc(100% - 2rem); max-width: 24.375rem; max-height: calc(100dvh - 2rem); border-radius: var(--radius-xl); padding-top: 1.5rem; padding-bottom: 1.5rem; transform: translate(-50%, -50%); }
    .portfolio-notes-dialog[open] { gap: 1.25rem; animation: portfolio-notes-dialog-enter 100ms ease-out; }
    .portfolio-notes-drag-handle { display: none; }
}
@media (prefers-reduced-motion: reduce) {
    .portfolio-notes-dialog[open] { animation: none; }
    .portfolio-notes-height { transition: none; }
    .portfolio-note-transition, .portfolio-note-transition[data-direction="-1"] { animation: portfolio-note-fade 100ms ease-out both; }
}
@keyframes portfolio-note-fade { from { opacity: 0; } to { opacity: 1; } }
`;
