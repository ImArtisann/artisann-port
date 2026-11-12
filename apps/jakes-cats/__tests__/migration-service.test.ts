import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CatsInternalApi } from "@artisann-port/cats-domain/cats-internal.api";
import { HeartService } from "../src/server/heart-service.ts";
import { MigrationService } from "../src/server/migration-service.ts";
import { HeartsService } from "../src/server/hearts-service.ts";
import { ORIGINAL_TIME, PHOTO_A, PHOTO_B, VISITOR_A, VISITOR_B, catsWorld } from "./cats-world.ts";

it("imports an online baseline, retries durable replay, fences old writers and hands off without losing acknowledged writes", async () => {
    const world = catsWorld();
    world.db.sqlite
        .prepare("INSERT INTO photo_hearts(photo_key,visitor_id,created_at) VALUES (?,?,?)")
        .run(PHOTO_A, VISITOR_A, ORIGINAL_TIME);
    world.db.sqlite
        .prepare(
            "INSERT INTO photo_comments(id,photo_key,visitor_id,body,created_at) VALUES (41,?,?,?,?)",
        )
        .run(PHOTO_A, VISITOR_A, "An original comment", ORIGINAL_TIME);
    world.installCapture();
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                const source = yield* HeartsService;
                const prepared = yield* migration.prepare;
                expect(prepared).toMatchObject({
                    mode: "source",
                    hearts_high: 1,
                    comments_high: 41,
                    checkpoint: 0,
                });
                expect((yield* migration.handoff.pipe(Effect.flip)).reason).toBe("WrongMode");
                expect(yield* source.heart(PHOTO_A, VISITOR_B)).toBe(2);
                const concurrent = yield* source.addComment(
                    PHOTO_A,
                    VISITOR_B,
                    "Accepted during the baseline",
                );
                expect(concurrent.id).toBe(42);
                expect((yield* migration.prepare).comments_high).toBe(41);
                expect((yield* migration.exportPage("comments", 0, 1)).facts).toEqual([
                    {
                        cursor: 41,
                        kind: "comment",
                        photo_key: PHOTO_A,
                        visitor_id: VISITOR_A,
                        created_at: ORIGINAL_TIME,
                        comment_id: 41,
                        body: "An original comment",
                    },
                ]);
                yield* migration.importPage("hearts", 1);
                yield* migration.importPage("comments", 1);
                expect((yield* migration.status).differences).toBe(2);
                world.db.failCheckpointOnce = true;
                expect((yield* migration.importPage("changes", 1).pipe(Effect.flip)).reason).toBe(
                    "Unavailable",
                );
                expect((yield* migration.status).checkpoint).toBe(0);
                const internal = yield* CatsInternalApi.clientInProcess;
                expect((yield* internal.Photo.get(PHOTO_A)).likes).toBe(2);
                yield* migration.importPage("changes", 1);
                expect((yield* internal.Photo.get(PHOTO_A)).likes).toBe(2);
                const beforeFence = yield* source.addComment(
                    PHOTO_A,
                    VISITOR_A,
                    "Acknowledged just before the fence",
                );
                expect(beforeFence.id).toBe(43);
                const fenced = yield* migration.fence;
                expect(fenced).toMatchObject({ mode: "fenced", fence_seq: 3, checkpoint: 1 });
                expect((yield* migration.handoff.pipe(Effect.flip)).reason).toBe("NotConverged");
                expect(() =>
                    world.db.sqlite
                        .prepare(
                            "INSERT INTO photo_hearts(photo_key,visitor_id,created_at) VALUES (?,?,?)",
                        )
                        .run(PHOTO_B, VISITOR_A, ORIGINAL_TIME),
                ).toThrow("cats_source_fenced");
                expect(() =>
                    world.db.sqlite
                        .prepare(
                            "INSERT INTO photo_comments(photo_key,visitor_id,body,created_at) VALUES (?,?,?,?)",
                        )
                        .run(PHOTO_A, VISITOR_A, "Must never be acknowledged", ORIGINAL_TIME),
                ).toThrow("cats_source_fenced");
                expect((yield* source.heart(PHOTO_B, VISITOR_A).pipe(Effect.flip))._tag).toBe(
                    "Hearts.Error",
                );
                yield* migration.importPage("changes", 1);
                yield* migration.importPage("changes", 1);
                expect(yield* migration.status).toMatchObject({
                    checkpoint: 3,
                    differences: 0,
                    baselineComplete: true,
                });
                expect((yield* migration.handoff).mode).toBe("domain");
                expect((yield* migration.handoff).mode).toBe("domain");
                expect((yield* migration.abort.pipe(Effect.flip)).reason).toBe("WrongMode");
                const preserved = yield* internal.Photo.get(PHOTO_A);
                expect(preserved.hearts[VISITOR_A]).toBe(ORIGINAL_TIME);
                expect(preserved.comments.find((comment) => comment.id === 41)).toEqual({
                    id: 41,
                    visitorId: VISITOR_A,
                    body: "An original comment",
                    createdAt: ORIGINAL_TIME,
                });
                const heart = yield* HeartService;
                expect((yield* heart.heart(PHOTO_A, VISITOR_A, "ip-a")).likes).toBe(2);
                const after = yield* heart.comment(
                    PHOTO_A,
                    VISITOR_A,
                    "ip-a",
                    "Written only to the new authority",
                );
                expect(after.comment).toMatchObject({ id: 44, mine: true });
                expect(
                    world.db.sqlite.prepare("SELECT COUNT(*) AS count FROM photo_comments").get(),
                ).toEqual({ count: 3 });
                expect(
                    world.db.sqlite
                        .prepare("SELECT COUNT(*) AS count FROM cats_domain_comments")
                        .get(),
                ).toEqual({ count: 4 });
                expect((yield* migration.status).capturedThrough).toBe(3);
                const exportPage = yield* migration.exportPage("changes", 0, 1);
                expect(exportPage).toMatchObject({ cursor: 1, through: 3, complete: false });
                expect(
                    (yield* migration.exportPage(
                        "changes",
                        exportPage.cursor,
                        100,
                        exportPage.through,
                    )).facts,
                ).toHaveLength(2);
                expect(() =>
                    world.db.sqlite
                        .prepare(
                            "INSERT INTO photo_hearts(photo_key,visitor_id,created_at) VALUES (?,?,?)",
                        )
                        .run(PHOTO_B, VISITOR_B, ORIGINAL_TIME),
                ).toThrow("cats_source_fenced");
                const fresh = yield* CatsInternalApi.clientInProcess;
                expect((yield* fresh.Photo.get(PHOTO_A)).comments).toHaveLength(4);
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});

it("allows a fenced migration to resume source writes only before handoff", async () => {
    const world = catsWorld();
    world.installCapture();
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                yield* migration.prepare;
                yield* migration.fence;
                expect((yield* migration.abort).mode).toBe("source");
                const source = yield* HeartsService;
                expect(yield* source.heart(PHOTO_A, VISITOR_A)).toBe(1);
                expect((yield* migration.status).capturedThrough).toBe(1);
                yield* migration.importPage("changes", 100);
                yield* migration.fence;
                expect((yield* migration.handoff).mode).toBe("domain");
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});

it("rejects an old-source write that read source mode before the atomic fence", async () => {
    const world = catsWorld();
    world.installCapture();
    const reachedInsert = Promise.withResolvers<void>();
    const releaseInsert = Promise.withResolvers<void>();
    world.db.beforeWrite = (sql) => {
        if (!sql.startsWith("INSERT INTO photo_hearts")) return Promise.resolve();
        reachedInsert.resolve();
        return releaseInsert.promise;
    };
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                yield* migration.prepare;
                const source = yield* HeartsService;
                const racingWriter = yield* Effect.forkScoped(source.heart(PHOTO_A, VISITOR_A));
                yield* Effect.promise(() => reachedInsert.promise);
                expect((yield* migration.fence).mode).toBe("fenced");
                releaseInsert.resolve();
                expect((yield* Fiber.join(racingWriter).pipe(Effect.flip))._tag).toBe(
                    "Hearts.Error",
                );
                expect((yield* migration.status).capturedThrough).toBe(0);
                expect(
                    world.db.sqlite.prepare("SELECT COUNT(*) AS count FROM photo_hearts").get(),
                ).toEqual({ count: 0 });
                expect((yield* migration.handoff).mode).toBe("domain");
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        releaseInsert.resolve();
        world.db.sqlite.close();
    }
});
