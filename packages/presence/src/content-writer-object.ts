/**
 * The authoritative site-content writer: one Durable Object instance
 * (`ContentWriterController`, single stable object name `site-content`) that owns the
 * document and its revision counter, and projects every accepted change into
 * the public KV namespace the website reads.
 *
 * Invariants this class enforces:
 * - The DO's stored document is authoritative; KV is a read-only mirror.
 *   The DO document and revision are persisted BEFORE the projection, so a
 *   crash between the two leaves a `dirty` state that the alarm (or a
 *   repeated request) reconciles — never a lost approval.
 * - Every entry point — state reads, mutations, and the alarm — serializes
 *   through ONE semaphore permit, so bootstrap, reads, mutations and
 *   reconciliations can never interleave and a stale authority can never
 *   overwrite a newer one.
 * - `replace` is compare-and-swap on `revision` and may never change notes.
 * - Every authority commit stamps a strictly monotonic `updatedAt`.
 * - `publishedRevision` advances only when the projection of that exact
 *   revision has been accepted; projections never overlap on the wire, and
 *   every projection run re-reads the LATEST authority before writing, so a
 *   late write always reconciles the newest document.
 * - Rejection markers persist only `{id, decision}` in DO storage; rejected
 *   text never reaches site content or KV. A reject of a published id is
 *   answered `already-approved` — refused, never retroactively applied.
 * - Every failure response is a sanitized machine code; no diagnostic cause,
 *   no authenticated value, ever leaves this class.
 *
 * A KV projection that does not settle within {@link PROJECTION_TIMEOUT_MS}
 * counts as uncertain, with the alarm retrying — the caller never waits
 * unbounded and the write is never assumed failed.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { CONTENT_KEY } from "./config.ts";
import { DEFAULT_SITE_CONTENT, decodeContentDocument, MAX_NOTES, SiteContent } from "./content.ts";
import {
    encodeContentDocument,
    PROJECTION_RETRY_MS,
    PROJECTION_TIMEOUT_MS,
    sameNoteContent,
    type ContentWriterAction,
    type ContentWriterErrorKind,
    type ContentWriterResult,
    type ContentWriterState,
    type ApproveAction,
    type ContentWriterEnv,
    type DeleteNoteAction,
    type DurableObjectStateLike,
    type ReplaceAction,
} from "./content-writer.ts";

/** Internal storage keys. Marker payloads hold only the id and the decision. */
const STATE_KEY = "state";
const REJECTION_MARKER_PREFIX = "rejected:";
const REJECTION_MARKER_TOMBSTONE = "rejected";
const equivalentNotes = Schema.toEquivalence(SiteContent.fields.notes);

/** The persisted form: the encoded document plus its projection bookkeeping. */
interface StoredState {
    readonly revision: number;
    /** The revision whose projection has actually been accepted by KV. */
    readonly publishedRevision: number;
    /** The authoritative document as encoded JSON text. */
    readonly document: string;
    /** `true` while the projection of `revision` is owed or uncertain. */
    readonly dirty: boolean;
}

/** The result of one bounded projection attempt. */
type Projection = "accepted" | "uncertain" | "failed";

type WriterOutcome = ContentWriterResult | { readonly error: ContentWriterErrorKind };

/**
 * A strictly increasing ISO timestamp for an authority commit: never equal to
 * or behind the document's previous `updatedAt`, whatever the clock does.
 */
function nextUpdatedAt(previous: string | null, now: number): string {
    const previousMs = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous);
    const ms = Number.isNaN(previousMs) || now > previousMs ? now : previousMs + 1;
    return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

export class ContentWriterController {
    private canonicalDocument: string | undefined;
    private readonly lock = Semaphore.makeUnsafe(1);
    /**
     * The native KV write currently in flight, if any. A projection attempt
     * never starts while a previous one is unsettled, whatever its response
     * deadline said.
     */
    private inFlightWrite: Promise<"accepted" | "failed"> | null = null;

    constructor(
        private readonly doState: DurableObjectStateLike,
        private readonly env: ContentWriterEnv,
    ) {}

    private run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
        return Effect.runPromise(this.lock.withPermits(1)(effect));
    }

    getState(): Promise<ContentWriterState> {
        return this.run(this.serveState());
    }

    apply(action: ContentWriterAction): Promise<WriterOutcome> {
        return this.run(this.applyAction(action)).catch(() => error("unavailable"));
    }

    /** Alarm invocation: reconcile the owed projection under the same lock. */
    alarm(): Promise<void> {
        return this.run(this.pump());
    }

    private serveState() {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.ensureState();
            return yield* this.toWriterState(stored);
        });
    }

    private applyAction(action: ContentWriterAction) {
        if (action.action === "replace") return this.replace(action);
        if (action.action === "approve") return this.approve(action);
        if (action.action === "delete") return this.deleteNote(action);
        return this.reject(action);
    }

    /** CAS whole-document replace. Notes are preserved exactly, or refused. */
    private replace(action: ReplaceAction) {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.ensureState();
            if (action.revision !== stored.revision) return error("conflict");
            const current = yield* this.decode(stored.document);
            if (!equivalentNotes(action.content.notes, current.notes)) {
                // The notes list belongs to the moderation flow alone; a CMS edit
                // that would alter it is a caller bug, not a partial write.
                return error("validation");
            }
            const now = yield* Clock.currentTimeMillis;
            const document = yield* this.encode({
                ...action.content,
                updatedAt: nextUpdatedAt(current.updatedAt, now),
            });
            return yield* this.commit(
                {
                    revision: stored.revision + 1,
                    publishedRevision: stored.publishedRevision,
                    document,
                    dirty: true,
                },
                "updated",
            );
        });
    }

    private approve(action: ApproveAction) {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.ensureState();
            const marker = yield* Effect.promise(() =>
                this.doState.storage.get<{
                    readonly id: string;
                    readonly decision: string;
                }>(REJECTION_MARKER_PREFIX + action.id),
            );
            if (marker !== undefined) {
                // A rejected submission is final: answered without publishing,
                // without mutating anything.
                return yield* this.respond("already-rejected", stored);
            }
            const content = yield* this.decode(stored.document);
            const existing = content.notes.find((note) => note.id === action.id);
            if (existing !== undefined) {
                if (!sameNoteContent(existing, action)) return error("validation");
                // Publication state is only claimed once the mirror is confirmed:
                // a failed or uncertain projection keeps the decision pending.
                if (stored.dirty) {
                    yield* this.pump();
                    const after = yield* this.readStored();
                    if (after === undefined || after.dirty) return error("unavailable");
                }
                const latest = yield* this.readStored();
                return yield* this.respond("already-approved", latest ?? stored);
            }
            if (content.notes.length >= MAX_NOTES) {
                // Capacity is reported, never silently evicted: the submission
                // stays pending in the Discord inbox.
                return error("capacity");
            }
            const now = yield* Clock.currentTimeMillis;
            const document = yield* this.encode({
                ...content,
                notes: [
                    ...content.notes,
                    {
                        id: action.id,
                        name: action.name,
                        body: action.body,
                        submittedAt: action.submittedAt,
                        approvedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                    },
                ],
                updatedAt: nextUpdatedAt(content.updatedAt, now),
            });
            return yield* this.commit(
                {
                    revision: stored.revision + 1,
                    publishedRevision: stored.publishedRevision,
                    document,
                    dirty: true,
                },
                "approved",
            );
        });
    }

    private deleteNote(action: DeleteNoteAction) {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.ensureState();
            const content = yield* this.decode(stored.document);
            if (!content.notes.some((note) => note.id === action.id)) {
                // A prior deletion may still be visible in the unconfirmed mirror.
                if (stored.dirty) return error("unavailable");
                return yield* this.respond("not-found", stored);
            }
            const now = yield* Clock.currentTimeMillis;
            const document = yield* this.encode({
                ...content,
                notes: content.notes.filter((note) => note.id !== action.id),
                updatedAt: nextUpdatedAt(content.updatedAt, now),
            });
            return yield* this.commit(
                {
                    revision: stored.revision + 1,
                    publishedRevision: stored.publishedRevision,
                    document,
                    dirty: true,
                },
                "deleted",
            );
        });
    }

    private reject(action: { action: "reject"; id: string }) {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.ensureState();
            const marker = yield* Effect.promise(() =>
                this.doState.storage.get<{
                    readonly id: string;
                    readonly decision: string;
                }>(REJECTION_MARKER_PREFIX + action.id),
            );
            if (marker !== undefined) {
                return yield* this.respond("already-rejected", stored);
            }
            const content = yield* this.decode(stored.document);
            if (content.notes.some((note) => note.id === action.id)) {
                // Authoritative content wins over any stale interaction: the
                // review message may have been updated already. Refused as a
                // success outcome, never retroactively applied.
                if (stored.dirty) return error("unavailable");
                return yield* this.respond("already-approved", stored);
            }
            // Persist only the decision — never the visitor text.
            yield* Effect.promise(() =>
                this.doState.storage.put(REJECTION_MARKER_PREFIX + action.id, {
                    id: action.id,
                    decision: REJECTION_MARKER_TOMBSTONE,
                }),
            );
            return yield* this.respond("rejected", stored);
        });
    }

    /**
     * Persist the authoritative state first, then run the projection pump.
     * The mutation is durable either way; only a confirmed mirror lets the
     * success outcome be claimed, otherwise the caller sees 503.
     */
    private commit(next: StoredState, outcome: "updated" | "approved" | "deleted") {
        return Effect.gen({ self: this }, function* () {
            // Arm recovery before committing authority: termination between the
            // durable write and the projection must not strand an approved note.
            const due = (yield* Clock.currentTimeMillis) + PROJECTION_RETRY_MS;
            const alarm = yield* Effect.promise(() => this.doState.storage.getAlarm());
            if (alarm === null || alarm === undefined || alarm > due) {
                yield* Effect.promise(() => this.doState.storage.setAlarm(due));
            }
            yield* this.persist(next);
            yield* this.pump();
            const stored = yield* this.readStored();
            if (stored === undefined || stored.dirty) return error("unavailable");
            return yield* this.respond(outcome, stored);
        });
    }

    /**
     * Reconcile the KV mirror with the current authority.
     *
     * Re-reads stored authority so whichever invocation gets the lock next —
     * alarm, repeated approval, or a later mutation — always projects the
     * LATEST document. A projection is never started while an earlier native
     * write is still unsettled. One attempt runs per invocation; uncertain or
     * failed writes arm the alarm instead of looping in-memory.
     */
    private pump() {
        return Effect.gen({ self: this }, function* () {
            if (this.inFlightWrite !== null) {
                const pending = yield* this.awaitProjection(this.inFlightWrite);
                if (pending === "uncertain") {
                    const retryAt = (yield* Clock.currentTimeMillis) + PROJECTION_RETRY_MS;
                    yield* Effect.promise(() => this.doState.storage.setAlarm(retryAt));
                    return;
                }
            }
            this.inFlightWrite = null;
            const stored = yield* this.readStored();
            if (stored === undefined || !stored.dirty) return;
            const outcome = yield* this.attemptProjection(stored.document);
            if (outcome === "accepted") {
                yield* this.persist({
                    revision: stored.revision,
                    publishedRevision: stored.revision,
                    document: stored.document,
                    dirty: false,
                });
                return;
            }
            const retryAt =
                (yield* Clock.currentTimeMillis) +
                (outcome === "failed" ? PROJECTION_RETRY_MS : PROJECTION_RETRY_MS * 4);
            yield* Effect.promise(() => this.doState.storage.setAlarm(retryAt));
        });
    }

    /**
     * One bounded projection attempt. On `uncertain` the native write stays
     * referenced in {@link inFlightWrite}; the next pump run waits for it to
     * settle before issuing anything else.
     */
    private attemptProjection(document: string) {
        const write = this.env.PRESENCE_KV.put(CONTENT_KEY, document);
        // `then` already normalizes rejection, so the in-flight reference can
        // be awaited safely at any later time.
        this.inFlightWrite = write.then(
            () => "accepted" as const,
            () => "failed" as const,
        );
        return this.awaitProjection(this.inFlightWrite);
    }

    private awaitProjection(write: Promise<Projection>) {
        return Effect.promise(() => write).pipe(
            Effect.timeoutOrElse({
                duration: PROJECTION_TIMEOUT_MS,
                orElse: () => Effect.succeed("uncertain" as const),
            }),
        );
    }

    private readStored() {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* Effect.promise(() =>
                this.doState.storage.get<StoredState>(STATE_KEY),
            );
            if (stored !== undefined && stored.document !== this.canonicalDocument) {
                // Decode legacy records before touching them so malformed
                // authority data fails closed. Re-encode only the document; the
                // revision, publication marker, dirty bit, and rejection markers
                // remain unchanged.
                const canonical = yield* this.encode(yield* this.decode(stored.document));
                if (canonical !== stored.document) {
                    const migrated = { ...stored, document: canonical };
                    yield* this.persist(migrated);
                    this.canonicalDocument = canonical;
                    return migrated;
                }
                this.canonicalDocument = canonical;
            }
            return stored;
        });
    }

    private ensureState() {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* this.readStored();
            if (stored !== undefined) return stored;
            // Bootstrap: adopt whatever KV holds as revision 1 — that projection
            // is already published by definition. Runs under the lock, so no
            // mutation can interleave with the adopt.
            const existing = yield* Effect.promise(() => this.env.PRESENCE_KV.get(CONTENT_KEY));
            // KV is also a legacy storage boundary. Validate and canonicalize it
            // before persisting the bootstrap record; a malformed value must not
            // be replaced by defaults.
            const content = existing === null ? DEFAULT_SITE_CONTENT : yield* this.decode(existing);
            const document = yield* this.encode(content);
            const fresh: StoredState = {
                revision: 1,
                publishedRevision: 1,
                document,
                dirty: false,
            };
            yield* this.persist(fresh);
            return fresh;
        });
    }

    private persist(state: StoredState) {
        return Effect.promise(() => this.doState.storage.put(STATE_KEY, state));
    }

    private toWriterState(stored: StoredState) {
        return this.decode(stored.document).pipe(
            Effect.map((content) => ({
                revision: stored.revision,
                content,
                publishedRevision: stored.publishedRevision,
            })),
        );
    }

    private decode(document: string) {
        // Corrupt authority data fails the native call. The service maps it
        // to an unavailable result, never to defaults.
        return decodeContentDocument(document);
    }

    private encode(content: SiteContent) {
        return encodeContentDocument(content);
    }

    private respond(outcome: ContentWriterResult["outcome"], stored: StoredState) {
        return this.toWriterState(stored).pipe(Effect.map((state) => ({ outcome, state })));
    }
}

function error(kind: ContentWriterErrorKind) {
    return { error: kind };
}
