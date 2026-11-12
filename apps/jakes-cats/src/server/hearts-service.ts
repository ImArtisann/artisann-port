import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AcceptComment } from "@artisann-port/cats-domain/accept-comment.command";
import { HeartPhoto } from "@artisann-port/cats-domain/heart-photo.command";
import { Photo } from "@artisann-port/cats-domain/photo.aggregate";
import { PhotoIndex } from "@artisann-port/cats-domain/photo-index.projection";
import { Timestamp } from "@artisann-port/cats-domain/photo.id";
import type { PhotoTag } from "@artisann-port/presence/photos";
import type { PhotoComment } from "../contracts.ts";

export interface HeartsStatement {
    bind(...values: unknown[]): HeartsStatement;
    all(): Promise<{ readonly results: ReadonlyArray<unknown> }>;
    first(): Promise<Schema.Json>;
    run(): Promise<HeartsRunResult>;
}
export interface HeartsRunResult {
    readonly success: boolean;
}
export interface HeartsD1Binding {
    prepare(query: string): HeartsStatement;
}
export class HeartsBinding extends Context.Service<HeartsBinding, HeartsD1Binding>()(
    "Hearts.Binding",
) {}
export class HeartsError extends Schema.TaggedError<HeartsError>()("Hearts.Error", {
    operation: Schema.Literals(["counts", "hearted", "heart", "register", "comments", "comment"]),
}) {}
export interface HeartsOperations {
    readonly countsFor: (tag: PhotoTag) => Effect.Effect<ReadonlyMap<string, number>, HeartsError>;
    readonly heartedBy: (visitorId: string) => Effect.Effect<ReadonlySet<string>, HeartsError>;
    readonly heart: (key: string, visitorId: string) => Effect.Effect<number, HeartsError>;
    readonly register: (
        key: string,
        tag: PhotoTag,
        uploadedAt: string,
    ) => Effect.Effect<void, HeartsError>;
    readonly commentsFor: (
        key: string,
        limit: number,
        visitorId: string,
    ) => Effect.Effect<PhotoComment[], HeartsError>;
    readonly addComment: (
        key: string,
        visitorId: string,
        body: string,
    ) => Effect.Effect<PhotoComment, HeartsError>;
}
export class HeartsService extends Context.Service<HeartsService, HeartsOperations>()(
    "Hearts.Service",
) {}
export const HEARTS_COUNTS_SQL =
    "SELECT h.photo_key AS key, COUNT(*) AS likes FROM photo_hearts h WHERE h.photo_key LIKE ?1 || '/%' GROUP BY h.photo_key";
export const HEARTS_HEARTED_SQL = "SELECT photo_key AS key FROM photo_hearts WHERE visitor_id = ?1";
export const HEARTS_HEART_SQL =
    "INSERT INTO photo_hearts (photo_key, visitor_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING";
export const HEARTS_COUNT_SQL = "SELECT COUNT(*) AS likes FROM photo_hearts WHERE photo_key = ?1";
export const PHOTOS_REGISTER_SQL =
    "INSERT INTO photos (key, tag, uploaded_at, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO NOTHING";
export const COMMENTS_FOR_SQL =
    "SELECT id, visitor_id, body, created_at FROM photo_comments WHERE photo_key = ?1 ORDER BY id DESC LIMIT ?2";
export const COMMENT_INSERT_SQL =
    "INSERT INTO photo_comments (photo_key, visitor_id, body, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id, visitor_id, body, created_at";
const CountRow = Schema.Struct({
    key: Schema.String,
    likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const Count = Schema.Struct({ likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });
const KeyRow = Schema.Struct({ key: Schema.String });
const CommentRow = Schema.Struct({
    id: Schema.Int,
    visitor_id: Schema.String,
    body: Schema.String,
    created_at: Timestamp,
});
export const AuthorityRow = Schema.Struct({
    mode: Schema.Literals(["source", "fenced", "domain"]),
});
export const authorityMode = Effect.fn("Cats.authorityMode")(function* (db: HeartsD1Binding) {
    const row = yield* Effect.tryPromise({
        try: () => db.prepare("SELECT mode FROM cats_migration WHERE id = 1").first(),
        catch: () => new HeartsError({ operation: "counts" }),
    });
    return (yield* Schema.decodeUnknownEffect(AuthorityRow)(row).pipe(
        Effect.mapError(() => new HeartsError({ operation: "counts" })),
    )).mode;
});
const failure = (operation: HeartsError["operation"]) => () => new HeartsError({ operation });

export const HeartsLive = Layer.effect(
    HeartsService,
    Effect.gen(function* () {
        const db = yield* HeartsBinding;
        const photo = yield* Photo;
        const projection = yield* PhotoIndex.Progress;
        const table = Effect.map(authorityMode(db), (mode) =>
            mode === "domain" ? "cats_domain_hearts" : "photo_hearts",
        );
        const countsFor = Effect.fn("Hearts.countsFor")(function* (tag: PhotoTag) {
            const source = yield* table;
            const result = yield* Effect.tryPromise({
                try: () =>
                    db.prepare(HEARTS_COUNTS_SQL.replace("photo_hearts", source)).bind(tag).all(),
                catch: failure("counts"),
            });
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
                result.results,
            ).pipe(Effect.mapError(failure("counts")));
            return new Map(rows.map((row) => [row.key, row.likes]));
        });
        const heartedBy = Effect.fn("Hearts.heartedBy")(function* (visitorId: string) {
            const source = yield* table;
            const result = yield* Effect.tryPromise({
                try: () =>
                    db
                        .prepare(HEARTS_HEARTED_SQL.replace("photo_hearts", source))
                        .bind(visitorId)
                        .all(),
                catch: failure("hearted"),
            });
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(KeyRow))(
                result.results,
            ).pipe(Effect.mapError(failure("hearted")));
            return new Set(rows.map((row) => row.key));
        });
        const heart = Effect.fn("Hearts.heart")(function* (key: string, visitorId: string) {
            const mode = yield* authorityMode(db);
            if (mode === "fenced") return yield* new HeartsError({ operation: "heart" });
            if (mode === "domain") {
                const receipt = yield* photo.send(key, new HeartPhoto({ visitorId }));
                yield* projection.caughtUp(receipt).pipe(Effect.mapError(failure("heart")));
                // No-op receipts have no events for caughtUp to wait on.
                if (receipt.events.length === 0) {
                    const row = yield* Effect.tryPromise({
                        try: () =>
                            db
                                .prepare(
                                    HEARTS_COUNT_SQL.replace("photo_hearts", "cats_domain_hearts"),
                                )
                                .bind(key)
                                .first(),
                        catch: failure("heart"),
                    });
                    const projected = yield* Schema.decodeUnknownEffect(Count)(row).pipe(
                        Effect.mapError(failure("heart")),
                    );
                    if (projected.likes < receipt.reply.likes)
                        return yield* new HeartsError({ operation: "heart" });
                }
                return receipt.reply.likes;
            }
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const written = yield* Effect.tryPromise({
                try: () => db.prepare(HEARTS_HEART_SQL).bind(key, visitorId, createdAt).run(),
                catch: failure("heart"),
            });
            if (!written.success) return yield* new HeartsError({ operation: "heart" });
            const row = yield* Effect.tryPromise({
                try: () => db.prepare(HEARTS_COUNT_SQL).bind(key).first(),
                catch: failure("heart"),
            });
            return (yield* Schema.decodeUnknownEffect(Count)(row).pipe(
                Effect.mapError(failure("heart")),
            )).likes;
        });
        const register = Effect.fn("Hearts.register")(function* (
            key: string,
            tag: PhotoTag,
            uploadedAt: string,
        ) {
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const written = yield* Effect.tryPromise({
                try: () =>
                    db.prepare(PHOTOS_REGISTER_SQL).bind(key, tag, uploadedAt, createdAt).run(),
                catch: failure("register"),
            });
            if (!written.success) return yield* new HeartsError({ operation: "register" });
        });
        const commentsFor = Effect.fn("Hearts.commentsFor")(function* (
            key: string,
            limit: number,
            visitorId: string,
        ) {
            const mode = yield* authorityMode(db);
            if (mode === "domain") {
                const state = yield* photo.state(key);
                return [...state.comments]
                    .sort((a, b) => b.id - a.id)
                    .slice(0, limit)
                    .map((comment) => ({
                        id: comment.id,
                        body: comment.body,
                        createdAt: comment.createdAt,
                        mine: comment.visitorId === visitorId,
                    }));
            }
            const result = yield* Effect.tryPromise({
                try: () => db.prepare(COMMENTS_FOR_SQL).bind(key, limit).all(),
                catch: failure("comments"),
            });
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(CommentRow))(
                result.results,
            ).pipe(Effect.mapError(failure("comments")));
            return rows.map((row) => ({
                id: row.id,
                body: row.body,
                createdAt: row.created_at,
                mine: row.visitor_id === visitorId,
            }));
        });
        const addComment = Effect.fn("Hearts.addComment")(function* (
            key: string,
            visitorId: string,
            body: string,
        ) {
            const mode = yield* authorityMode(db);
            if (mode === "fenced") return yield* new HeartsError({ operation: "comment" });
            if (mode === "domain") {
                const receipt = yield* photo
                    .send(key, new AcceptComment({ visitorId, body }))
                    .pipe(Effect.mapError(failure("comment")));
                yield* projection.caughtUp(receipt).pipe(Effect.mapError(failure("comment")));
                const comment = receipt.reply.comment;
                if (comment === null) return yield* new HeartsError({ operation: "comment" });
                return {
                    id: comment.id,
                    body: comment.body,
                    createdAt: comment.createdAt,
                    mine: true,
                };
            }
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const row = yield* Effect.tryPromise({
                try: () =>
                    db.prepare(COMMENT_INSERT_SQL).bind(key, visitorId, body, createdAt).first(),
                catch: failure("comment"),
            });
            const comment = yield* Schema.decodeUnknownEffect(CommentRow)(row).pipe(
                Effect.mapError(failure("comment")),
            );
            return {
                id: comment.id,
                body: comment.body,
                createdAt: comment.created_at,
                mine: true,
            };
        });
        return HeartsService.of({ countsFor, heartedBy, heart, register, commentsFor, addComment });
    }),
);
