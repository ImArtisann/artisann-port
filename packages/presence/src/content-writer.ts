/**
 * The content-writer protocol: the pure contract between the bot (outside
 * Cloudflare), the Worker, and the `ContentWriterController` that owns the
 * authoritative site-content document.
 *
 * Everything here is browser-safe data — schemas and typed error contracts —
 * stable object/binding names. No credentials, no transport, no I/O: the bot
 * client and the DO implement this contract from both ends.
 *
 * Design invariants the DO enforces:
 * - The DO's stored document is authoritative; KV is a read-only projection.
 * - `replace` is a compare-and-swap on `revision` and may never change notes.
 * - Rejection markers persist only `{id, decision}` inside the DO — never in
 *   site content, never public.
 * - Failure results carry a sanitized machine code, never a diagnostic cause.
 */
import * as Schema from "effect/Schema";
import { NoteBody, NoteName, SiteContent, IsoTimestamp } from "./content.ts";
import type { PresenceKvBinding } from "./store.ts";

/** The single Durable Object instance name backing all site content. */
export const CONTENT_WRITER_OBJECT_NAME = "site-content";

/** Visitor note ids: a stable 32-character lowercase hex submission id. */
export const NoteId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));

export type NoteId = Schema.Schema.Type<typeof NoteId>;

/** The authoritative writer state: revision counter plus its KV projection. */
export const ContentWriterState = Schema.Struct({
    /** Monotonic revision of the authoritative document; CAS token for replace. */
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    content: SiteContent,
    /**
     * The revision the KV mirror is known to hold. A revision above this is
     * projected (or being projected); the DO reconciles the gap itself.
     */
    publishedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ContentWriterState = typeof ContentWriterState.Type;

/** Replace the whole document. CAS: fails with `conflict` on a stale revision. */
export const ReplaceAction = Schema.Struct({
    action: Schema.Literal("replace"),
    revision: Schema.Int,
    content: SiteContent,
});

export type ReplaceAction = typeof ReplaceAction.Type;

/** Approve one pending visitor note into the document. */
export const ApproveAction = Schema.Struct({
    action: Schema.Literal("approve"),
    id: NoteId,
    name: NoteName,
    body: NoteBody,
    submittedAt: IsoTimestamp,
});

export type ApproveAction = typeof ApproveAction.Type;

/** Record a rejection. No site-content mutation, ever. */
export const RejectAction = Schema.Struct({
    action: Schema.Literal("reject"),
    id: NoteId,
});

export type RejectAction = typeof RejectAction.Type;

/** One typed authority mutation. */
export const ContentWriterAction = Schema.Union([ReplaceAction, ApproveAction, RejectAction]);

export type ContentWriterAction = Schema.Schema.Type<typeof ContentWriterAction>;

export const ContentWriterOutcome = Schema.Literals([
    "updated",
    "approved",
    "already-approved",
    "rejected",
    "already-rejected",
]);

export type ContentWriterOutcome = typeof ContentWriterOutcome.Type;

/** Every success response carries the full post-decision state. */
export const ContentWriterResult = Schema.Struct({
    outcome: ContentWriterOutcome,
    state: ContentWriterState,
});

export type ContentWriterResult = typeof ContentWriterResult.Type;

/** Machine-readable, sanitized failure codes. Never a diagnostic cause. */
export const ContentWriterErrorKind = Schema.Literals([
    "conflict",
    "validation",
    "capacity",
    "unavailable",
]);

export type ContentWriterErrorKind = typeof ContentWriterErrorKind.Type;

/**
 * Encode a validated document into the JSON text stored in KV — the exact
 * inverse of `decodeContentDocument`. The DO projects this string.
 */
export const encodeContentDocument = Schema.encodeEffect(Schema.fromJsonString(SiteContent));

/**
 * The subset of a Durable Object namespace binding the Worker uses to reach
 * the writer. Declared structurally — no `@cloudflare/workers-types`
 * dependency.
 */
export interface DurableObjectIdLike {
    toString(): string;
}

export interface ContentWriterStub {
    getState(): Promise<ContentWriterState>;
    apply(
        action: ContentWriterAction,
    ): Promise<ContentWriterResult | { readonly error: ContentWriterErrorKind }>;
}

export interface ContentWriterBinding {
    idFromName(name: string): DurableObjectIdLike;
    get(id: DurableObjectIdLike): ContentWriterStub;
}

/**
 * The subset of Durable Object storage the writer persists to. Values are
 * transparently (de)serialized by the runtime; alarms drive projection
 * reconciliation.
 */
export interface DurableObjectStorageLike {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null | undefined>;
}

/** The subset of `DurableObjectState` the writer needs. */
export interface DurableObjectStateLike {
    readonly storage: DurableObjectStorageLike;
}

/** Bindings the `ContentWriterController` itself needs. */
export interface ContentWriterEnv {
    /** The KV namespace the authoritative document projects into. */
    readonly PRESENCE_KV: PresenceKvBinding;
}

/** How long one KV projection may take before it counts as uncertain. */
export const PROJECTION_TIMEOUT_MS = 10_000;

/** Delay before the alarm retries an uncertain or failed projection. */
export const PROJECTION_RETRY_MS = 30_000;

/** Upper bound of one encoded content action, in bytes. */
export const CONTENT_WRITER_BODY_BYTES_MAX = 1_048_576;

/**
 * Compare two note payloads for approval idempotency: an approve whose name
 * and body match what is already published is a retry, not a conflict.
 */
export function sameNoteContent(
    existing: { readonly name: string | null; readonly body: string },
    action: { readonly name: string | null; readonly body: string },
): boolean {
    return existing.name === action.name && existing.body === action.body;
}
