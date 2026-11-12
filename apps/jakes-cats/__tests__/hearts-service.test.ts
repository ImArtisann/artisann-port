import { describe, expect, it } from "vite-plus/test";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Cats } from "@artisann-port/cats-domain/cats.model";
import { CatsApi } from "@artisann-port/cats-domain/cats.api";
import { CatsInternalApi } from "@artisann-port/cats-domain/cats-internal.api";
import { HeartService } from "../src/server/heart-service.ts";
import { DeckService } from "../src/server/deck-service.ts";
import { MigrationService } from "../src/server/migration-service.ts";
import { PHOTO_A, VISITOR_A, VISITOR_B, catsWorld } from "./cats-world.ts";

describe("Cats authoritative model and trusted API", () => {
    it("has a valid model declaration", () => expect(Domain.verify(Cats)).toEqual([]));
    it("fails a source comment read whose stored timestamp is corrupt", async () => {
        const world = catsWorld();
        world.installCapture();
        world.db.sqlite
            .prepare(
                "INSERT INTO photo_comments (photo_key, visitor_id, body, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(PHOTO_A, VISITOR_A, "A fluffy cat", "yesterday");
        try {
            const failure = await Effect.runPromise(
                Effect.gen(function* () {
                    const deck = yield* DeckService;
                    return yield* deck
                        .detail(PHOTO_A.slice("cats/".length, -".webp".length), VISITOR_A)
                        .pipe(Effect.flip);
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
            expect(failure).toMatchObject({ _tag: "Deck.Error", operation: "photo.read" });
        } finally {
            world.db.sqlite.close();
        }
    });
    it("keeps repeat hearts idempotent and accepts only moderated bounded comments", async () => {
        const world = catsWorld();
        world.installCapture();
        const boundedComment = `${"This cat is wonderfully fluffy. ".repeat(10).slice(0, 279)}!`;
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const migration = yield* MigrationService;
                    yield* migration.prepare;
                    yield* migration.fence;
                    yield* migration.handoff;
                    const heart = yield* HeartService;
                    expect(yield* heart.heart(PHOTO_A, VISITOR_A, "ip-a")).toEqual({
                        key: PHOTO_A,
                        likes: 1,
                        hearted: true,
                    });
                    expect(yield* heart.heart(PHOTO_A, VISITOR_A, "ip-a")).toEqual({
                        key: PHOTO_A,
                        likes: 1,
                        hearted: true,
                    });
                    expect(yield* heart.heart(PHOTO_A, VISITOR_B, "ip-b")).toEqual({
                        key: PHOTO_A,
                        likes: 2,
                        hearted: true,
                    });
                    const accepted = yield* heart.comment(
                        PHOTO_A,
                        VISITOR_A,
                        "ip-a",
                        `  ${boundedComment}  `,
                    );
                    expect(accepted.comment).toMatchObject({
                        id: 1,
                        body: boundedComment,
                        mine: true,
                    });
                    expect(accepted.comment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
                    expect(
                        (yield* heart
                            .comment(PHOTO_A, VISITOR_A, "ip-a", "b".repeat(281))
                            .pipe(Effect.flip)).reason,
                    ).toBe("CommentTooLong");
                    expect(
                        (yield* heart.comment(PHOTO_A, VISITOR_A, "ip-a", "  ").pipe(Effect.flip))
                            .reason,
                    ).toBe("EmptyComment");
                    expect(
                        (yield* heart
                            .comment(PHOTO_A, VISITOR_A, "ip-a", "a".repeat(280))
                            .pipe(Effect.flip)).reason,
                    ).toBe("Filtered");
                    world.moderation.unavailable = true;
                    expect(
                        (yield* heart
                            .comment(
                                PHOTO_A,
                                VISITOR_B,
                                "ip-b",
                                "A provider outage must not publish this",
                            )
                            .pipe(Effect.flip)).reason,
                    ).toBe("Unavailable");
                    world.moderation.unavailable = false;
                    world.moderation.profane = true;
                    expect(
                        (yield* heart
                            .comment(PHOTO_A, VISITOR_B, "ip-b", "A refused comment")
                            .pipe(Effect.flip)).reason,
                    ).toBe("Filtered");
                    world.limits.allowed = false;
                    expect(
                        (yield* heart.heart(PHOTO_A, VISITOR_B, "ip-b").pipe(Effect.flip)).reason,
                    ).toBe("RateLimited");
                    world.limits.allowed = true;
                    world.objects.delete(PHOTO_A);
                    expect(
                        (yield* heart.heart(PHOTO_A, VISITOR_B, "ip-b").pipe(Effect.flip)).reason,
                    ).toBe("NotFound");
                    world.objects.set(PHOTO_A, new Date());
                    yield* world.settle;
                    const api = yield* CatsInternalApi.clientInProcess;
                    expect(
                        (yield* api
                            .AcceptComment(PHOTO_A, { visitorId: VISITOR_A, body: "x".repeat(281) })
                            .pipe(Effect.flip))._tag,
                    ).toBe("InvalidComment");
                    expect((yield* api.Photo.get(PHOTO_A)).comments).toHaveLength(1);
                    const deck = yield* DeckService;
                    expect((yield* deck.detail("123456789012345678", VISITOR_A)).comments).toEqual([
                        accepted.comment,
                    ]);
                    expect(
                        (yield* deck.detail("123456789012345678", VISITOR_B)).comments[0]?.mine,
                    ).toBe(false);
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
    it("publishes only counts in public snapshots and event history", async () => {
        const world = catsWorld();
        world.installCapture();
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const internal = yield* CatsInternalApi.clientInProcess;
                    yield* internal.HeartPhoto(PHOTO_A, { visitorId: VISITOR_A });
                    yield* internal.AcceptComment(PHOTO_A, {
                        visitorId: VISITOR_A,
                        body: "private visitor-linked text",
                    });
                    yield* world.settle;
                    const publicApi = yield* CatsApi.clientInProcess;
                    expect(yield* publicApi.PhotoCounts.get(PHOTO_A)).toEqual({ likes: 1 });
                    const history = yield* publicApi.PhotoCounts.list(PHOTO_A);
                    expect(history.entries.map((entry) => entry.event)).toEqual([
                        { _tag: "PhotoCountChanged", likes: 1 },
                    ]);
                    expect(JSON.stringify(history)).not.toContain(VISITOR_A);
                    expect(JSON.stringify(history)).not.toContain("private visitor-linked text");
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
});

it("returns only the newest hundred accepted comments with reader-specific ownership", async () => {
    const world = catsWorld();
    world.installCapture();
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                yield* migration.prepare;
                yield* migration.fence;
                yield* migration.handoff;
                const api = yield* CatsInternalApi.clientInProcess;
                for (let index = 1; index <= 101; index++) {
                    yield* api.AcceptComment(PHOTO_A, {
                        visitorId: index % 2 === 0 ? VISITOR_A : VISITOR_B,
                        body: `Accepted comment ${index}`,
                    });
                }
                const detail = yield* (yield* DeckService).detail("123456789012345678", VISITOR_A);
                expect(detail.comments).toHaveLength(100);
                expect(detail.comments[0]).toMatchObject({
                    id: 101,
                    body: "Accepted comment 101",
                    mine: false,
                });
                expect(detail.comments[1]).toMatchObject({ id: 100, mine: true });
                expect(detail.comments[99]).toMatchObject({
                    id: 2,
                    body: "Accepted comment 2",
                    mine: true,
                });
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});
