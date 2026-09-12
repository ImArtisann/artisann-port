/**
 * Hearts, comments, and the photo registry live in D1. This module owns every
 * statement the site issues against `photo_hearts`, `photo_comments`, and
 * `photos` — the deck's counts and this visitor's hearts, the leaderboard's
 * heart counts, a photo page's comments, and the registry row an upload claims.
 *
 * Rows are decoded with Schema, so a corrupt row fails the read instead of
 * silently defaulting to zero hearts, and comments are shaped before they
 * leave this module so a visitor id can never reach a client.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { PhotoTag } from "@artisann-port/presence/photos";
import type { PhotoComment } from "../contracts.ts";

/** One row as D1 hands it back, before decoding. */
export interface HeartsRawRow {
    readonly key?: string;
    readonly likes?: number;
    readonly id?: number;
    readonly visitor_id?: string;
    readonly body?: string;
    readonly created_at?: string;
}

/** One prepared statement, as far as this service drives it. */
export interface HeartsStatement {
    bind(...values: unknown[]): HeartsStatement;
    all(): Promise<{ readonly results: ReadonlyArray<HeartsRawRow> }>;
    first(): Promise<HeartsRawRow | null>;
    run(): Promise<HeartsRunResult>;
}

/** What a write reports back; the writers only care that it succeeded. */
export interface HeartsRunResult {
    readonly success?: boolean;
}

/**
 * The native D1 surface this service drives, kept structural rather than
 * `Pick<D1Database, "prepare">`: a real `D1Database` satisfies it, and tests
 * can fake it without reimplementing D1's whole statement class.
 */
export interface HeartsD1Binding {
    prepare(query: string): HeartsStatement;
}

export class HeartsError extends Schema.TaggedError<HeartsError>()("Hearts.Error", {
    operation: Schema.Literals(["counts", "hearted", "heart", "register", "comments", "comment"]),
}) {}

export class HeartsBinding extends Context.Service<HeartsBinding, HeartsD1Binding>()(
    "Hearts.Binding",
) {}

/** Every heart on one collection, grouped by photo. */
export const HEARTS_COUNTS_SQL =
    "SELECT h.photo_key AS key, COUNT(*) AS likes FROM photo_hearts h " +
    "WHERE h.photo_key LIKE ?1 || '/%' GROUP BY h.photo_key";

/** Every photo one visitor has hearted. */
export const HEARTS_HEARTED_SQL = "SELECT photo_key AS key FROM photo_hearts WHERE visitor_id = ?1";

/** One heart. A repeat heart from the same visitor is a no-op, not a bump. */
export const HEARTS_HEART_SQL =
    "INSERT INTO photo_hearts (photo_key, visitor_id, created_at) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT DO NOTHING";

/** The authoritative count of one photo, read after the heart landed. */
export const HEARTS_COUNT_SQL = "SELECT COUNT(*) AS likes FROM photo_hearts WHERE photo_key = ?1";

/** Claim a freshly uploaded photo; an existing row wins. */
export const PHOTOS_REGISTER_SQL =
    "INSERT INTO photos (key, tag, uploaded_at, created_at) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(key) DO NOTHING";

/** The newest comments of one photo, newest first. */
export const COMMENTS_FOR_SQL =
    "SELECT id, visitor_id, body, created_at FROM photo_comments " +
    "WHERE photo_key = ?1 ORDER BY id DESC LIMIT ?2";

/** One comment, as stored; `RETURNING` hands back the id the row got. */
export const COMMENT_INSERT_SQL =
    "INSERT INTO photo_comments (photo_key, visitor_id, body, created_at) " +
    "VALUES (?1, ?2, ?3, ?4) RETURNING id, body, created_at";

const CountRow = Schema.Struct({
    key: Schema.String,
    likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const HeartedRow = Schema.Struct({
    key: Schema.String,
});

const HeartCountRow = Schema.Struct({
    likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const CommentRow = Schema.Struct({
    id: Schema.Int,
    visitor_id: Schema.String,
    body: Schema.String,
    created_at: Schema.String,
});

const InsertedCommentRow = Schema.Struct({
    id: Schema.Int,
    body: Schema.String,
    created_at: Schema.String,
});

const decodeCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const decodeHeartCount = Schema.decodeUnknownEffect(HeartCountRow);
const decodeHeartedRows = Schema.decodeUnknownEffect(Schema.Array(HeartedRow));
const decodeCommentRows = Schema.decodeUnknownEffect(Schema.Array(CommentRow));
const decodeInsertedComment = Schema.decodeUnknownEffect(InsertedCommentRow);

/** Shape one stored comment for the client; the visitor id never crosses over. */
function toComment(row: typeof CommentRow.Type, visitorId: string): PhotoComment {
    return {
        id: row.id,
        body: row.body,
        createdAt: row.created_at,
        mine: row.visitor_id === visitorId,
    };
}

/** What the deck, the photo page, the heart action, and uploads need from storage. */
export interface HeartsOperations {
    /** Heart count per photo key of one collection. */
    readonly countsFor: (tag: PhotoTag) => Effect.Effect<ReadonlyMap<string, number>, HeartsError>;
    /** The photo keys one visitor has hearted. */
    readonly heartedBy: (visitorId: string) => Effect.Effect<ReadonlySet<string>, HeartsError>;
    /** Land one heart and return the authoritative count, unchanged on a repeat. */
    readonly heart: (key: string, visitorId: string) => Effect.Effect<number, HeartsError>;
    /** Claim an uploaded photo; an existing row is left alone. */
    readonly register: (
        key: string,
        tag: PhotoTag,
        uploadedAt: string,
    ) => Effect.Effect<void, HeartsError>;
    /** The newest comments of one photo, `mine` marked for this visitor. */
    readonly commentsFor: (
        key: string,
        limit: number,
        visitorId: string,
    ) => Effect.Effect<PhotoComment[], HeartsError>;
    /** Store one comment and hand it back as the client will see it. */
    readonly addComment: (
        key: string,
        visitorId: string,
        body: string,
    ) => Effect.Effect<PhotoComment, HeartsError>;
}

export class HeartsService extends Context.Service<HeartsService, HeartsOperations>()(
    "Hearts.Service",
) {}

/**
 * Native D1-backed hearts and comments. Acquisition captures the binding; no
 * I/O starts here, and every statement is prepared per call.
 *
 * `heart` issues its insert and its count as two statements because the
 * binding is a narrow `prepare` surface with no `batch`. The count is read
 * after the insert, so a concurrent heart from another visitor can only make
 * the answer more current, never wrong: the insert is idempotent per visitor
 * and the count is the table's own.
 */
export const HeartsLive = Layer.effect(
    HeartsService,
    Effect.gen(function* () {
        const binding = yield* HeartsBinding;

        const countsFor = Effect.fn("Hearts.countsFor")(function* (tag: PhotoTag) {
            const result = yield* Effect.tryPromise({
                try: () => binding.prepare(HEARTS_COUNTS_SQL).bind(tag).all(),
                catch: () => new HeartsError({ operation: "counts" }),
            });
            const rows = yield* decodeCountRows(result.results).pipe(
                Effect.mapError(() => new HeartsError({ operation: "counts" })),
            );
            const counts = new Map<string, number>();
            for (const row of rows) counts.set(row.key, row.likes);
            return counts;
        });

        const heartedBy = Effect.fn("Hearts.heartedBy")(function* (visitorId: string) {
            const result = yield* Effect.tryPromise({
                try: () => binding.prepare(HEARTS_HEARTED_SQL).bind(visitorId).all(),
                catch: () => new HeartsError({ operation: "hearted" }),
            });
            const rows = yield* decodeHeartedRows(result.results).pipe(
                Effect.mapError(() => new HeartsError({ operation: "hearted" })),
            );
            const hearted = new Set<string>();
            for (const row of rows) hearted.add(row.key);
            return hearted;
        });

        const heart = Effect.fn("Hearts.heart")(function* (key: string, visitorId: string) {
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            yield* Effect.tryPromise({
                try: () => binding.prepare(HEARTS_HEART_SQL).bind(key, visitorId, createdAt).run(),
                catch: () => new HeartsError({ operation: "heart" }),
            });
            const row = yield* Effect.tryPromise({
                try: () => binding.prepare(HEARTS_COUNT_SQL).bind(key).first(),
                catch: () => new HeartsError({ operation: "heart" }),
            });
            const decoded = yield* decodeHeartCount(row).pipe(
                Effect.mapError(() => new HeartsError({ operation: "heart" })),
            );
            return decoded.likes;
        });

        const register = Effect.fn("Hearts.register")(function* (
            key: string,
            tag: PhotoTag,
            uploadedAt: string,
        ) {
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            yield* Effect.tryPromise({
                try: () =>
                    binding
                        .prepare(PHOTOS_REGISTER_SQL)
                        .bind(key, tag, uploadedAt, createdAt)
                        .run(),
                catch: () => new HeartsError({ operation: "register" }),
            });
        });

        const commentsFor = Effect.fn("Hearts.commentsFor")(function* (
            key: string,
            limit: number,
            visitorId: string,
        ) {
            const result = yield* Effect.tryPromise({
                try: () => binding.prepare(COMMENTS_FOR_SQL).bind(key, limit).all(),
                catch: () => new HeartsError({ operation: "comments" }),
            });
            const rows = yield* decodeCommentRows(result.results).pipe(
                Effect.mapError(() => new HeartsError({ operation: "comments" })),
            );
            return rows.map((row) => toComment(row, visitorId));
        });

        const addComment = Effect.fn("Hearts.addComment")(function* (
            key: string,
            visitorId: string,
            body: string,
        ) {
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const row = yield* Effect.tryPromise({
                try: () =>
                    binding
                        .prepare(COMMENT_INSERT_SQL)
                        .bind(key, visitorId, body, createdAt)
                        .first(),
                catch: () => new HeartsError({ operation: "comment" }),
            });
            const inserted = yield* decodeInsertedComment(row).pipe(
                Effect.mapError(() => new HeartsError({ operation: "comment" })),
            );
            return {
                id: inserted.id,
                body: inserted.body,
                createdAt: inserted.created_at,
                mine: true,
            };
        });

        return { countsFor, heartedBy, heart, register, commentsFor, addComment };
    }),
);
