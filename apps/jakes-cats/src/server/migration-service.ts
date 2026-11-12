import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { ImportPhotoFact } from "@artisann-port/cats-domain/import-photo-fact.command";
import { Photo } from "@artisann-port/cats-domain/photo.aggregate";
import { PhotoIndex } from "@artisann-port/cats-domain/photo-index.projection";
import { HeartsBinding } from "./hearts-service.ts";

export class MigrationError extends Schema.TaggedError<MigrationError>()("Cats.MigrationError", {
    reason: Schema.Literals([
        "Unavailable",
        "NotPrepared",
        "WrongMode",
        "BaselineIncomplete",
        "NotConverged",
        "InvalidSource",
    ]),
}) {}
const StatusRow = Schema.Struct({
    mode: Schema.Literals(["source", "fenced", "domain"]),
    prepared: Schema.Int,
    hearts_high: Schema.Int,
    comments_high: Schema.Int,
    hearts_cursor: Schema.Int,
    comments_cursor: Schema.Int,
    checkpoint: Schema.Int,
    fence_seq: Schema.NullOr(Schema.Int),
    handed_off_at: Schema.NullOr(Schema.String),
});
const Fact = Schema.Struct({
    cursor: Schema.Int,
    kind: Schema.Literals(["heart", "comment"]),
    photo_key: Schema.String,
    visitor_id: Schema.String,
    created_at: Schema.String,
    comment_id: Schema.NullOr(Schema.Int),
    body: Schema.NullOr(Schema.String),
});
const Difference = Schema.Struct({ differences: Schema.Int });
const HIGH_WATER_SQL =
    "UPDATE cats_migration SET prepared=1, hearts_high=(SELECT COALESCE(MAX(id),0) FROM cats_source_heart_ids), comments_high=(SELECT COALESCE(MAX(id),0) FROM photo_comments) WHERE id=1 AND mode='source' AND prepared=0";
// Compare exact rows both ways, including original identities and times.
export const DIFFERENCES_SQL = `SELECT (
    (SELECT COUNT(*) FROM (SELECT photo_key,visitor_id,created_at FROM photo_hearts EXCEPT SELECT photo_key,visitor_id,created_at FROM cats_domain_hearts)) +
    (SELECT COUNT(*) FROM (SELECT photo_key,visitor_id,created_at FROM cats_domain_hearts EXCEPT SELECT photo_key,visitor_id,created_at FROM photo_hearts)) +
    (SELECT COUNT(*) FROM (SELECT photo_key,id,visitor_id,body,created_at FROM photo_comments EXCEPT SELECT photo_key,id,visitor_id,body,created_at FROM cats_domain_comments)) +
    (SELECT COUNT(*) FROM (SELECT photo_key,id,visitor_id,body,created_at FROM cats_domain_comments EXCEPT SELECT photo_key,id,visitor_id,body,created_at FROM photo_comments))
) AS differences`;
export type MigrationStatus = typeof StatusRow.Type & {
    readonly capturedThrough: number;
    readonly differences: number;
    readonly baselineComplete: boolean;
};
export type MigrationExport = {
    readonly facts: ReadonlyArray<typeof Fact.Type>;
    readonly cursor: number;
    readonly through: number;
    readonly complete: boolean;
};
export interface MigrationOperations {
    readonly prepare: Effect.Effect<MigrationStatus, MigrationError>;
    readonly status: Effect.Effect<MigrationStatus, MigrationError>;
    readonly importPage: (
        phase: "hearts" | "comments" | "changes",
        take: number,
    ) => Effect.Effect<MigrationStatus, MigrationError>;
    readonly exportPage: (
        phase: "hearts" | "comments" | "changes",
        after: number,
        take: number,
        through?: number,
    ) => Effect.Effect<MigrationExport, MigrationError>;
    readonly fence: Effect.Effect<MigrationStatus, MigrationError>;
    readonly handoff: Effect.Effect<MigrationStatus, MigrationError>;
    readonly abort: Effect.Effect<MigrationStatus, MigrationError>;
}
export class MigrationService extends Context.Service<MigrationService, MigrationOperations>()(
    "Cats.Migration",
) {}
const unavailable = () => new MigrationError({ reason: "Unavailable" });
export const MigrationLive = Layer.effect(
    MigrationService,
    Effect.gen(function* () {
        const db = yield* HeartsBinding;
        const photo = yield* Photo;
        const projection = yield* PhotoIndex.Progress;
        const run = Effect.fn("Cats.Migration.write")(function* (
            sql: string,
            ...values: ReadonlyArray<string | number>
        ) {
            const result = yield* Effect.tryPromise({
                try: () =>
                    db
                        .prepare(sql)
                        .bind(...values)
                        .run(),
                catch: unavailable,
            });
            if (!result.success) return yield* unavailable();
        });
        const row = Effect.tryPromise({
            try: () =>
                db
                    .prepare(
                        "SELECT mode,prepared,hearts_high,comments_high,hearts_cursor,comments_cursor,checkpoint,fence_seq,handed_off_at FROM cats_migration WHERE id=1",
                    )
                    .first(),
            catch: unavailable,
        }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(StatusRow)),
            Effect.mapError(unavailable),
        );
        const status = Effect.gen(function* () {
            const state = yield* row;
            const captured = yield* Effect.tryPromise({
                try: () =>
                    db
                        .prepare(
                            "SELECT COALESCE(MAX(seq),0) AS differences FROM cats_source_changes",
                        )
                        .first(),
                catch: unavailable,
            }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Difference)),
                Effect.mapError(unavailable),
            );
            const difference = yield* Effect.tryPromise({
                try: () => db.prepare(DIFFERENCES_SQL).first(),
                catch: unavailable,
            }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Difference)),
                Effect.mapError(unavailable),
            );
            return {
                ...state,
                capturedThrough: captured.differences,
                differences: difference.differences,
                baselineComplete:
                    state.prepared === 1 &&
                    state.hearts_cursor >= state.hearts_high &&
                    state.comments_cursor >= state.comments_high,
            };
        });
        const prepare = Effect.gen(function* () {
            const state = yield* row;
            if (state.mode !== "source") return yield* new MigrationError({ reason: "WrongMode" });
            yield* run(HIGH_WATER_SQL);
            return yield* status;
        });
        const readPage = Effect.fn("Cats.Migration.readPage")(function* (
            phase: "hearts" | "comments" | "changes",
            cursor: number,
            high: number,
            limit: number,
        ) {
            const sql = Match.value(phase).pipe(
                Match.when(
                    "hearts",
                    () =>
                        "SELECT s.id AS cursor, 'heart' AS kind, h.photo_key,h.visitor_id,h.created_at,NULL AS comment_id,NULL AS body FROM cats_source_heart_ids s JOIN photo_hearts h ON h.photo_key=s.photo_key AND h.visitor_id=s.visitor_id WHERE s.id>?1 AND s.id<=?2 ORDER BY s.id LIMIT ?3",
                ),
                Match.when(
                    "comments",
                    () =>
                        "SELECT id AS cursor, 'comment' AS kind, photo_key,visitor_id,created_at,id AS comment_id,body FROM photo_comments WHERE id>?1 AND id<=?2 ORDER BY id LIMIT ?3",
                ),
                Match.when(
                    "changes",
                    () =>
                        "SELECT seq AS cursor,kind,photo_key,visitor_id,created_at,comment_id,body FROM cats_source_changes WHERE seq>?1 AND seq<=?2 ORDER BY seq LIMIT ?3",
                ),
                Match.exhaustive,
            );
            const result = yield* Effect.tryPromise({
                try: () => db.prepare(sql).bind(cursor, high, limit).all(),
                catch: unavailable,
            });
            return yield* Schema.decodeUnknownEffect(Schema.Array(Fact))(result.results).pipe(
                Effect.mapError(() => new MigrationError({ reason: "InvalidSource" })),
            );
        });
        const exportPage = Effect.fn("Cats.Migration.exportPage")(function* (
            phase: "hearts" | "comments" | "changes",
            after: number,
            take: number,
            through?: number,
        ) {
            const state = yield* status;
            if (state.prepared !== 1) return yield* new MigrationError({ reason: "NotPrepared" });
            const high = Match.value(phase).pipe(
                Match.when("hearts", () => state.hearts_high),
                Match.when("comments", () => state.comments_high),
                Match.when("changes", () => state.fence_seq ?? state.capturedThrough),
                Match.exhaustive,
            );
            const bound = through ?? high;
            if (
                !Number.isSafeInteger(after) ||
                !Number.isSafeInteger(bound) ||
                after < 0 ||
                bound < after ||
                bound > high ||
                !Number.isInteger(take) ||
                take < 1 ||
                take > 100
            )
                return yield* new MigrationError({ reason: "InvalidSource" });
            const facts = yield* readPage(phase, after, bound, take);
            const cursor = facts[facts.length - 1]?.cursor ?? bound;
            return {
                facts,
                cursor,
                through: bound,
                complete: facts.length < take || cursor >= bound,
            };
        });
        const importPage = Effect.fn("Cats.Migration.importPage")(function* (
            phase: "hearts" | "comments" | "changes",
            take: number,
        ) {
            const state = yield* row;
            if (state.prepared !== 1) return yield* new MigrationError({ reason: "NotPrepared" });
            if (state.mode === "domain") return yield* new MigrationError({ reason: "WrongMode" });
            const limit = Math.min(100, Math.max(1, Math.trunc(take)));
            const cursor = Match.value(phase).pipe(
                Match.when("hearts", () => state.hearts_cursor),
                Match.when("comments", () => state.comments_cursor),
                Match.when("changes", () => state.checkpoint),
                Match.exhaustive,
            );
            const high = Match.value(phase).pipe(
                Match.when("hearts", () => state.hearts_high),
                Match.when("comments", () => state.comments_high),
                Match.when("changes", () => state.fence_seq ?? Number.MAX_SAFE_INTEGER),
                Match.exhaustive,
            );
            const facts = yield* readPage(phase, cursor, high, limit);
            for (const fact of facts) {
                const receipt = yield* photo
                    .send(
                        fact.photo_key,
                        new ImportPhotoFact({
                            kind: fact.kind,
                            visitorId: fact.visitor_id,
                            createdAt: fact.created_at,
                            commentId: fact.comment_id,
                            body: fact.body,
                        }),
                        {
                            commandId:
                                phase === "changes"
                                    ? `cats-source-change:${fact.cursor}`
                                    : `cats-baseline:${phase}:${fact.cursor}`,
                        },
                    )
                    .pipe(Effect.mapError(() => new MigrationError({ reason: "InvalidSource" })));
                yield* projection.caughtUp(receipt).pipe(Effect.mapError(unavailable));
            }
            const last = facts[facts.length - 1]?.cursor ?? (phase === "changes" ? cursor : high);
            const column = Match.value(phase).pipe(
                Match.when("hearts", () => "hearts_cursor"),
                Match.when("comments", () => "comments_cursor"),
                Match.when("changes", () => "checkpoint"),
                Match.exhaustive,
            );
            yield* run(
                `UPDATE cats_migration SET ${column}=MAX(${column},?1) WHERE id=1 AND mode!='domain'`,
                last,
            );
            return yield* status;
        });
        const fence = Effect.gen(function* () {
            const state = yield* status;
            if (!state.baselineComplete)
                return yield* new MigrationError({ reason: "BaselineIncomplete" });
            if (state.mode === "domain") return yield* new MigrationError({ reason: "WrongMode" });
            // This statement serializes with trigger-protected source mutations.
            yield* run(
                "UPDATE cats_migration SET mode='fenced', fence_seq=(SELECT COALESCE(MAX(seq),0) FROM cats_source_changes) WHERE id=1 AND mode='source'",
            );
            return yield* status;
        });
        const handoff = Effect.gen(function* () {
            const state = yield* status;
            if (state.mode === "domain") return state;
            if (state.mode !== "fenced") return yield* new MigrationError({ reason: "WrongMode" });
            if (
                !state.baselineComplete ||
                state.checkpoint < (state.fence_seq ?? 0) ||
                state.differences !== 0
            )
                return yield* new MigrationError({ reason: "NotConverged" });
            yield* run(
                `UPDATE cats_migration SET mode='domain', handed_off_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 AND mode='fenced' AND prepared=1 AND hearts_cursor>=hearts_high AND comments_cursor>=comments_high AND checkpoint>=fence_seq AND (SELECT differences FROM (${DIFFERENCES_SQL}))=0`,
            );
            const after = yield* status;
            if (after.mode !== "domain")
                return yield* new MigrationError({ reason: "NotConverged" });
            return after;
        });
        const abort = Effect.gen(function* () {
            const state = yield* row;
            if (state.mode === "domain") return yield* new MigrationError({ reason: "WrongMode" });
            yield* run(
                "UPDATE cats_migration SET mode='source', fence_seq=NULL WHERE id=1 AND mode='fenced'",
            );
            return yield* status;
        });
        return MigrationService.of({
            prepare,
            status,
            importPage,
            exportPage,
            fence,
            handoff,
            abort,
        });
    }),
);
