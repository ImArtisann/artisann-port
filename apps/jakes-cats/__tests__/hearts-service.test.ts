/**
 * Heart, comment, and registry behavior. D1 lives behind a fake that executes
 * exactly the statements the service prepares, in the same order, so the tests
 * pin the SQL contract — one heart per visitor, one row per comment, ranks
 * ordered by hearts then key — without a database. The comment action is
 * exercised through the full `HeartService`, with a scripted moderation
 * provider standing in for profanity.dev.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { PhotoTag } from "@artisann-port/presence/photos";
import type { PhotosR2MutationBinding } from "../src/env.ts";
import { PhotosBinding } from "../src/server/deck-service.ts";
import {
    HeartError,
    HeartLive,
    HeartService,
    RateLimitBinding,
} from "../src/server/heart-service.ts";
import {
    COMMENT_INSERT_SQL,
    COMMENTS_FOR_SQL,
    HEARTS_COUNT_SQL,
    HEARTS_COUNTS_SQL,
    HEARTS_HEARTED_SQL,
    HEARTS_HEART_SQL,
    HEARTS_TOP_SQL,
    HeartsBinding,
    HeartsError,
    HeartsLive,
    HeartsService,
    PHOTOS_REGISTER_SQL,
    type HeartsD1Binding,
    type HeartsRawRow,
    type HeartsRunResult,
    type HeartsStatement,
} from "../src/server/hearts-service.ts";
import { ModerationLive } from "../src/server/moderation-service.ts";

interface FakeHeart {
    readonly visitorId: string;
    readonly createdAt: string;
}

interface FakeComment {
    readonly id: number;
    readonly photoKey: string;
    readonly visitorId: string;
    readonly body: string;
    readonly createdAt: string;
}

const CATS_KEY = "cats/123456789012345678.webp";
const OTHER_CATS_KEY = "cats/123456789012345679.webp";
const LIFE_KEY = "life/123456789012345678.webp";

const VISITOR_A = "0123456789abcdef0123456789abcdef";
const VISITOR_B = "fedcba9876543210fedcba9876543210";

/** An in-memory `photo_hearts` / `photo_comments` / `photos` store. */
class FakeHeartsDatabase implements HeartsD1Binding {
    readonly hearts = new Map<string, FakeHeart[]>();
    readonly photos = new Map<string, { readonly tag: string; readonly uploadedAt: string }>();
    readonly comments: FakeComment[] = [];
    private readonly scriptedTallies = new Map<string, ReadonlyArray<HeartsRawRow>>();
    private nextCommentId = 1;

    prepare(query: string): HeartsStatement {
        return new FakeStatement(this, query);
    }

    /** Replace one collection's raw counts, for the decoding tests. */
    scriptTallies(tag: string, rows: ReadonlyArray<HeartsRawRow>): void {
        this.scriptedTallies.set(tag, rows);
    }

    /** `HEARTS_HEART_SQL`: one heart per visitor, never a second row. */
    landHeart(key: string, visitorId: string, createdAt: string): void {
        const existing = this.hearts.get(key) ?? [];
        if (existing.some((heart) => heart.visitorId === visitorId)) return;
        existing.push({ visitorId, createdAt });
        this.hearts.set(key, existing);
    }

    /** `HEARTS_COUNTS_SQL` / `HEARTS_TOP_SQL`: one row per hearted key, best first. */
    talliesOf(tag: string): ReadonlyArray<HeartsRawRow> {
        const scripted = this.scriptedTallies.get(tag);
        if (scripted !== undefined) return scripted;

        return [...this.hearts.entries()]
            .filter(([key]) => key.startsWith(`${tag}/`))
            .map(([key, hearts]) => ({ key, likes: hearts.length }))
            .sort(
                (left, right) =>
                    (right.likes ?? 0) - (left.likes ?? 0) ||
                    (right.key ?? "").localeCompare(left.key ?? ""),
            );
    }

    /** `HEARTS_HEARTED_SQL`: every key one visitor has hearted. */
    heartedKeys(visitorId: string): ReadonlyArray<HeartsRawRow> {
        return [...this.hearts.entries()]
            .filter(([, hearts]) => hearts.some((heart) => heart.visitorId === visitorId))
            .map(([key]) => ({ key }));
    }

    /** `HEARTS_COUNT_SQL`: the authoritative count of one key. */
    countOf(key: string): number {
        return this.hearts.get(key)?.length ?? 0;
    }

    /** `PHOTOS_REGISTER_SQL`: claim a photo once; an existing row wins. */
    registerPhoto(key: string, tag: string, uploadedAt: string): void {
        if (this.photos.has(key)) return;
        this.photos.set(key, { tag, uploadedAt });
    }

    /** `COMMENTS_FOR_SQL`: the newest comments of one photo, newest first. */
    commentsOf(photoKey: string, limit: number): ReadonlyArray<HeartsRawRow> {
        return this.comments
            .filter((comment) => comment.photoKey === photoKey)
            .sort((left, right) => right.id - left.id)
            .slice(0, limit)
            .map((comment) => ({
                id: comment.id,
                visitor_id: comment.visitorId,
                body: comment.body,
                created_at: comment.createdAt,
            }));
    }

    /** `COMMENT_INSERT_SQL`: append one comment and return the row it got. */
    landComment(
        photoKey: string,
        visitorId: string,
        body: string,
        createdAt: string,
    ): HeartsRawRow {
        const id = this.nextCommentId++;
        this.comments.push({ id, photoKey, visitorId, body, createdAt });
        return { id, body, created_at: createdAt };
    }
}

class FakeStatement implements HeartsStatement {
    private readonly database: FakeHeartsDatabase;
    private readonly query: string;
    private readonly values: ReadonlyArray<string>;

    constructor(database: FakeHeartsDatabase, query: string, values: ReadonlyArray<string> = []) {
        this.database = database;
        this.query = query;
        this.values = values;
    }

    bind(...values: unknown[]): HeartsStatement {
        return new FakeStatement(
            this.database,
            this.query,
            values.map((value) => String(value)),
        );
    }

    async first(): Promise<HeartsRawRow | null> {
        if (this.query === HEARTS_COUNT_SQL) {
            return { likes: this.database.countOf(this.values[0] ?? "") };
        }
        if (this.query === COMMENT_INSERT_SQL) {
            return this.database.landComment(
                this.values[0] ?? "",
                this.values[1] ?? "",
                this.values[2] ?? "",
                this.values[3] ?? "",
            );
        }
        throw new Error(`first() outside a single-row statement: ${this.query}`);
    }

    async all(): Promise<{ readonly results: ReadonlyArray<HeartsRawRow> }> {
        if (this.query === HEARTS_COUNTS_SQL) {
            return { results: this.database.talliesOf(this.values[0] ?? "") };
        }
        if (this.query === HEARTS_TOP_SQL) {
            return {
                results: this.database
                    .talliesOf(this.values[0] ?? "")
                    .slice(0, Number(this.values[1])),
            };
        }
        if (this.query === HEARTS_HEARTED_SQL) {
            return { results: this.database.heartedKeys(this.values[0] ?? "") };
        }
        if (this.query === COMMENTS_FOR_SQL) {
            return {
                results: this.database.commentsOf(this.values[0] ?? "", Number(this.values[1])),
            };
        }
        throw new Error(`all() outside a read statement: ${this.query}`);
    }

    async run(): Promise<HeartsRunResult> {
        if (this.query === HEARTS_HEART_SQL) {
            this.database.landHeart(
                this.values[0] ?? "",
                this.values[1] ?? "",
                this.values[2] ?? "",
            );
            return { success: true };
        }
        if (this.query === PHOTOS_REGISTER_SQL) {
            this.database.registerPhoto(
                this.values[0] ?? "",
                this.values[1] ?? "",
                this.values[2] ?? "",
            );
            return { success: true };
        }
        throw new Error(`run() outside a write statement: ${this.query}`);
    }
}

/** Run one call against a fake database, with the production service layer. */
function runHearts<A, E>(
    effect: Effect.Effect<A, E, HeartsService>,
    database: FakeHeartsDatabase,
): Promise<A> {
    const layer = HeartsLive.pipe(Layer.provide(Layer.succeed(HeartsBinding, database)));
    return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

const countsFor = (tag: PhotoTag) =>
    Effect.flatMap(HeartsService, (service) => service.countsFor(tag));

const heartedBy = (visitorId: string) =>
    Effect.flatMap(HeartsService, (service) => service.heartedBy(visitorId));

const heart = (key: string, visitorId: string) =>
    Effect.flatMap(HeartsService, (service) => service.heart(key, visitorId));

const top = (tag: PhotoTag, limit: number) =>
    Effect.flatMap(HeartsService, (service) => service.top(tag, limit));

const register = (key: string, tag: PhotoTag, uploadedAt: string) =>
    Effect.flatMap(HeartsService, (service) => service.register(key, tag, uploadedAt));

const commentsFor = (key: string, limit: number, visitorId: string) =>
    Effect.flatMap(HeartsService, (service) => service.commentsFor(key, limit, visitorId));

const addComment = (key: string, visitorId: string, body: string) =>
    Effect.flatMap(HeartsService, (service) => service.addComment(key, visitorId, body));

describe("HeartsService", () => {
    it("counts one heart per visitor, however often they heart", async () => {
        const database = new FakeHeartsDatabase();

        expect(await runHearts(heart(CATS_KEY, VISITOR_A), database)).toBe(1);
        expect(await runHearts(heart(CATS_KEY, VISITOR_A), database)).toBe(1);
        expect(await runHearts(heart(CATS_KEY, VISITOR_B), database)).toBe(2);
        expect(await runHearts(heart(CATS_KEY, VISITOR_A), database)).toBe(2);
        expect(database.hearts.get(CATS_KEY)).toHaveLength(2);
    });

    it("counts one collection without touching the other", async () => {
        const database = new FakeHeartsDatabase();
        await runHearts(heart(CATS_KEY, VISITOR_A), database);
        await runHearts(heart(LIFE_KEY, VISITOR_A), database);

        const counts = await runHearts(countsFor("cats"), database);

        expect(counts.get(CATS_KEY)).toBe(1);
        expect(counts.has(LIFE_KEY)).toBe(false);
        expect(counts.size).toBe(1);
    });

    it("reports only the requesting visitor's hearts", async () => {
        const database = new FakeHeartsDatabase();
        await runHearts(heart(CATS_KEY, VISITOR_A), database);
        await runHearts(heart(LIFE_KEY, VISITOR_B), database);

        expect([...(await runHearts(heartedBy(VISITOR_A), database))]).toEqual([CATS_KEY]);
    });

    it("ranks by hearts and breaks ties with the newest key", async () => {
        const database = new FakeHeartsDatabase();
        await runHearts(heart(CATS_KEY, VISITOR_A), database);
        await runHearts(heart(CATS_KEY, VISITOR_B), database);
        await runHearts(heart(OTHER_CATS_KEY, VISITOR_A), database);
        await runHearts(heart(LIFE_KEY, VISITOR_A), database);

        expect(await runHearts(top("cats", 10), database)).toEqual([
            { key: CATS_KEY, likes: 2 },
            { key: OTHER_CATS_KEY, likes: 1 },
        ]);
        expect(await runHearts(top("cats", 1), database)).toEqual([{ key: CATS_KEY, likes: 2 }]);
    });

    it("fails the read on a corrupt row instead of defaulting", async () => {
        const negative = new FakeHeartsDatabase();
        negative.scriptTallies("cats", [{ key: CATS_KEY, likes: -1 }]);
        const invalid = await runHearts(Effect.flip(countsFor("cats")), negative);
        expect(invalid).toBeInstanceOf(HeartsError);
        expect(invalid.operation).toBe("counts");

        const incomplete = new FakeHeartsDatabase();
        incomplete.scriptTallies("cats", [{ key: CATS_KEY }]);
        const missing = await runHearts(Effect.flip(countsFor("cats")), incomplete);
        expect(missing).toBeInstanceOf(HeartsError);
    });

    it("claims an uploaded photo once and never rewrites the row", async () => {
        const database = new FakeHeartsDatabase();
        const uploadedAt = "2026-09-12T00:00:00.000Z";

        await runHearts(register(CATS_KEY, "cats", uploadedAt), database);
        expect(database.photos.get(CATS_KEY)?.uploadedAt).toBe(uploadedAt);

        await runHearts(register(CATS_KEY, "cats", "2026-09-12T01:00:00.000Z"), database);
        expect(database.photos.get(CATS_KEY)?.uploadedAt).toBe(uploadedAt);
    });

    it("marks only the requesting visitor's comments and never exposes a visitor id", async () => {
        const database = new FakeHeartsDatabase();
        await runHearts(addComment(CATS_KEY, VISITOR_A, "the first one"), database);
        await runHearts(addComment(CATS_KEY, VISITOR_B, "the second one"), database);

        const forA = await runHearts(commentsFor(CATS_KEY, 10, VISITOR_A), database);

        expect(forA.map((comment) => comment.body)).toEqual(["the second one", "the first one"]);
        expect(forA.map((comment) => comment.mine)).toEqual([false, true]);
        expect(Object.keys(forA[0] ?? {}).sort()).toEqual(["body", "createdAt", "id", "mine"]);
        expect(JSON.stringify(forA)).not.toContain(VISITOR_A);
        expect(JSON.stringify(forA)).not.toContain(VISITOR_B);

        const forB = await runHearts(commentsFor(CATS_KEY, 10, VISITOR_B), database);
        expect(forB.map((comment) => comment.mine)).toEqual([true, false]);
    });

    it("returns the newest comments first, capped at the limit", async () => {
        const database = new FakeHeartsDatabase();
        for (const body of ["one", "two", "three"]) {
            await runHearts(addComment(CATS_KEY, VISITOR_A, body), database);
        }
        await runHearts(addComment(LIFE_KEY, VISITOR_A, "elsewhere"), database);

        const newest = await runHearts(commentsFor(CATS_KEY, 2, VISITOR_A), database);

        expect(newest.map((comment) => comment.body)).toEqual(["three", "two"]);
        expect(newest.map((comment) => comment.mine)).toEqual([true, true]);
    });

    it("hands back the stored comment as the client will see it", async () => {
        const database = new FakeHeartsDatabase();

        const created = await runHearts(addComment(CATS_KEY, VISITOR_A, "hello"), database);

        expect(created.body).toBe("hello");
        expect(created.mine).toBe(true);
        expect(created.id).toBe(1);
        expect(database.comments[0]?.body).toBe("hello");
    });
});

/**
 * The moderation provider double: records what the service sent and answers
 * with the caller's verdict, so the comment action never leaves the process.
 */
function scriptedModeration(answer: () => Response) {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
            requests.push({
                url: url.toString(),
                body:
                    request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "",
            });
            return HttpClientResponse.fromWeb(request, answer());
        }),
    );
    return { client, requests };
}

/**
 * Run one comment action against the fake database, a passing edge rate limit,
 * an R2 probe that always finds the photo, and the scripted provider.
 */
function runComment<A, E>(
    effect: Effect.Effect<A, E, HeartService>,
    database: FakeHeartsDatabase,
    answer: () => Response,
) {
    const peer = scriptedModeration(answer);
    const probed: Array<string> = [];
    const headOnly = {
        head: (key: string) => {
            probed.push(key);
            return Promise.resolve({});
        },
    };
    // SAFETY: the comment action only calls `head`; no other R2 member is reached.
    const photos = headOnly as PhotosR2MutationBinding;
    const dependencies = Layer.mergeAll(
        HeartsLive.pipe(Layer.provide(Layer.succeed(HeartsBinding, database))),
        Layer.succeed(PhotosBinding, photos),
        Layer.succeed(RateLimitBinding, { limit: () => Promise.resolve({ success: true }) }),
        ModerationLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, peer.client))),
    );
    const result = Effect.runPromise(
        effect.pipe(Effect.provide(HeartLive.pipe(Layer.provide(dependencies)))),
    );
    return { result, peer, probed };
}

const postComment = (key: string, visitorId: string, body: string) =>
    Effect.flatMap(HeartService, (service) =>
        service.comment(key, visitorId, "comment-test-client", body),
    );

describe("HeartService comments", () => {
    it("refuses a comment the moderation provider flags, before any storage write", async () => {
        const database = new FakeHeartsDatabase();
        const body = "dang, look at that cat";
        const { result, peer, probed } = runComment(
            Effect.flip(postComment(CATS_KEY, VISITOR_A, body)),
            database,
            () => Response.json({ isProfanity: true, score: 0.93 }),
        );

        const error = await result;

        expect(error).toBeInstanceOf(HeartError);
        expect(error.reason).toBe("Filtered");
        expect(database.comments).toEqual([]);
        expect(probed).toEqual([]);
        expect(peer.requests.map((request) => request.url)).toEqual([
            "https://vector.profanity.dev/",
        ]);
        expect(JSON.parse(peer.requests[0]?.body ?? "{}")).toEqual({ message: body });
    });

    it("stores a comment the moderation provider clears, judged on the trimmed body", async () => {
        const database = new FakeHeartsDatabase();
        const { result, peer, probed } = runComment(
            postComment(CATS_KEY, VISITOR_A, "  hello from a visitor  "),
            database,
            () => Response.json({ isProfanity: false, score: 0.01 }),
        );

        const created = await result;

        expect(created.comment.body).toBe("hello from a visitor");
        expect(created.comment.mine).toBe(true);
        expect(database.comments).toHaveLength(1);
        expect(database.comments[0]?.body).toBe("hello from a visitor");
        expect(probed).toEqual([CATS_KEY]);
        expect(peer.requests).toHaveLength(1);
        expect(JSON.parse(peer.requests[0]?.body ?? "{}")).toEqual({
            message: "hello from a visitor",
        });
    });

    it("fails closed when the moderation provider is unavailable", async () => {
        const database = new FakeHeartsDatabase();
        const { result } = runComment(
            Effect.flip(postComment(CATS_KEY, VISITOR_A, "hello from a visitor")),
            database,
            () => new Response(null, { status: 503 }),
        );

        const error = await result;

        expect(error).toBeInstanceOf(HeartError);
        expect(error.reason).toBe("Unavailable");
        expect(database.comments).toEqual([]);
    });

    it("refuses local spam without asking the provider", async () => {
        const database = new FakeHeartsDatabase();
        const { result, peer, probed } = runComment(
            Effect.flip(postComment(CATS_KEY, VISITOR_A, "aaaaaaaaaa")),
            database,
            () => Response.json({ isProfanity: false, score: 0 }),
        );

        const error = await result;

        expect(error).toBeInstanceOf(HeartError);
        expect(error.reason).toBe("Filtered");
        expect(peer.requests).toEqual([]);
        expect(probed).toEqual([]);
        expect(database.comments).toEqual([]);
    });
});
