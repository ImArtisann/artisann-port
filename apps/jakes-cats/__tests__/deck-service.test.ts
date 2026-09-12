/**
 * Leaderboard behavior. The real `DeckLive` runs against an in-memory R2 bucket
 * and a fake D1 store, so the ranking is exercised end to end: heart counts come
 * from `HeartsLive`, liveness from the bucket listing, and the twenty-photo
 * limit is applied only after photos deleted from the bucket have dropped out.
 *
 * These tests exist because the limit and the liveness filter were once decided
 * in SQL, where deleted leaders could consume every slot and leave the
 * leaderboard short or empty.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PhotosR2Page } from "@artisann-port/presence/photos";
import type { PhotosR2MutationBinding } from "../src/env.ts";
import { LEADERBOARD_SIZE, SITE_PHOTO_TAG, type LeaderboardPayload } from "../src/contracts.ts";
import { DeckLive, DeckService, PhotosBinding, PhotosConfig } from "../src/server/deck-service.ts";
import {
    HEARTS_COUNTS_SQL,
    HEARTS_HEARTED_SQL,
    HeartsBinding,
    HeartsLive,
    type HeartsD1Binding,
    type HeartsRawRow,
    type HeartsRunResult,
    type HeartsStatement,
} from "../src/server/hearts-service.ts";

const ASSETS_HOST = "assets.example.com";
const VISITOR = "0123456789abcdef0123456789abcdef";

/** A managed `cats/` key whose snowflake grows with `id`, so keys sort by recency. */
const catsKey = (id: number): string =>
    `${SITE_PHOTO_TAG}/${String(100_000_000_000_000_000n + BigInt(id))}.webp`;

/**
 * An in-memory R2 bucket holding exactly the objects the leaderboard may rank.
 * The mutation members the leaderboard never reaches fail loudly if it does.
 */
class FakeBucket implements PhotosR2MutationBinding {
    private readonly objects = new Map<string, Date>();
    readonly listCalls: Array<{ readonly prefix: string; readonly cursor?: string }> = [];

    add(key: string, uploaded = new Date("2026-09-12T00:00:00.000Z")): void {
        this.objects.set(key, uploaded);
    }

    list(options: {
        prefix: string;
        cursor?: string | undefined;
        limit: number;
    }): Promise<PhotosR2Page> {
        this.listCalls.push({ prefix: options.prefix, cursor: options.cursor });
        return Promise.resolve({
            objects: [...this.objects].map(([key, uploaded]) => ({ key, uploaded })),
            truncated: false,
        });
    }

    head(): never {
        throw new Error("head() outside the leaderboard read");
    }

    put(): never {
        throw new Error("put() outside the leaderboard read");
    }

    delete(): never {
        throw new Error("delete() outside the leaderboard read");
    }
}

/** One heart row, keyed like `photo_hearts`: a visitor hearts a photo once. */
class FakeHearts implements HeartsD1Binding {
    private readonly hearts = new Map<string, Set<string>>();

    prepare(query: string): HeartsStatement {
        return new FakeStatement(this, query);
    }

    /** Record one heart, exactly as `HEARTS_HEART_SQL` would. */
    heart(key: string, visitorId: string): void {
        const visitors = this.hearts.get(key) ?? new Set<string>();
        visitors.add(visitorId);
        this.hearts.set(key, visitors);
    }

    /** `HEARTS_COUNTS_SQL`: one row per hearted key of the collection. */
    tallies(tag: string): ReadonlyArray<HeartsRawRow> {
        return [...this.hearts]
            .filter(([key]) => key.startsWith(`${tag}/`))
            .map(([key, visitors]) => ({ key, likes: visitors.size }));
    }

    /** `HEARTS_HEARTED_SQL`: every key one visitor has hearted. */
    hearted(visitorId: string): ReadonlyArray<HeartsRawRow> {
        return [...this.hearts]
            .filter(([, visitors]) => visitors.has(visitorId))
            .map(([key]) => ({ key }));
    }
}

class FakeStatement implements HeartsStatement {
    private readonly database: FakeHearts;
    private readonly query: string;
    private readonly values: ReadonlyArray<string>;

    constructor(database: FakeHearts, query: string, values: ReadonlyArray<string> = []) {
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
        throw new Error(`first() outside a single-row statement: ${this.query}`);
    }

    async all(): Promise<{ readonly results: ReadonlyArray<HeartsRawRow> }> {
        if (this.query === HEARTS_COUNTS_SQL) {
            return { results: this.database.tallies(this.values[0] ?? "") };
        }
        if (this.query === HEARTS_HEARTED_SQL) {
            return { results: this.database.hearted(this.values[0] ?? "") };
        }
        throw new Error(`all() outside a read statement: ${this.query}`);
    }

    async run(): Promise<HeartsRunResult> {
        throw new Error(`run() outside a write statement: ${this.query}`);
    }
}

/** Run one leaderboard read through the production layer stack. */
function runLeaderboard(bucket: FakeBucket, database: FakeHearts): Promise<LeaderboardPayload> {
    const dependencies = Layer.mergeAll(
        HeartsLive.pipe(Layer.provide(Layer.succeed(HeartsBinding, database))),
        Layer.succeed(PhotosBinding, bucket),
        Layer.succeed(PhotosConfig, { assetsHost: ASSETS_HOST }),
    );
    return Effect.runPromise(
        Effect.flatMap(DeckService, (deck) => deck.leaderboard(VISITOR)).pipe(
            Effect.provide(DeckLive.pipe(Layer.provide(dependencies))),
        ),
    );
}

describe("DeckService leaderboard", () => {
    it("ranks a live photo whose deleted rivals would have filled the limit", async () => {
        const bucket = new FakeBucket();
        const database = new FakeHearts();
        // Twenty photos since deleted from the bucket, each out-hearting the cat
        // that is still there. Ranking in SQL would return these alone.
        for (let index = 0; index < LEADERBOARD_SIZE; index++) {
            const key = catsKey(index);
            for (let heart = 0; heart <= LEADERBOARD_SIZE - index; heart++) {
                database.heart(key, `visitor-${index}-${heart}`);
            }
        }
        const survivor = catsKey(500);
        bucket.add(survivor);
        database.heart(survivor, VISITOR);

        const { entries } = await runLeaderboard(bucket, database);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.rank).toBe(1);
        expect(entries[0]?.photo.key).toBe(survivor);
        expect(entries[0]?.photo.likes).toBe(1);
        expect(entries[0]?.photo.hearted).toBe(true);
        expect(bucket.listCalls.map((call) => call.prefix)).toEqual([`${SITE_PHOTO_TAG}/`]);
    });

    it("caps live results at twenty with contiguous ranks and no zero-heart photo", async () => {
        const bucket = new FakeBucket();
        const database = new FakeHearts();
        const count = LEADERBOARD_SIZE + 5;
        // Key `index` is newer the larger it is, and least hearted, so both the
        // likes ordering and the tie-free key ordering are exercised.
        for (let index = 0; index < count; index++) {
            const key = catsKey(index);
            bucket.add(key);
            for (let heart = 0; heart < count - index; heart++) {
                database.heart(key, `visitor-${index}-${heart}`);
            }
        }
        const ignored = catsKey(999);
        bucket.add(ignored);

        const { entries } = await runLeaderboard(bucket, database);

        expect(entries).toHaveLength(LEADERBOARD_SIZE);
        expect(entries.map((entry) => entry.rank)).toEqual(
            Array.from({ length: LEADERBOARD_SIZE }, (_, index) => index + 1),
        );
        expect(entries.map((entry) => entry.photo.key)).toEqual(
            Array.from({ length: LEADERBOARD_SIZE }, (_, index) => catsKey(index)),
        );
        expect(entries.map((entry) => entry.photo.likes)).toEqual(
            Array.from({ length: LEADERBOARD_SIZE }, (_, index) => count - index),
        );
        expect(entries.some((entry) => entry.photo.key === ignored)).toBe(false);
    });

    it("breaks a heart tie with the newest key and drops every unhearted photo", async () => {
        const bucket = new FakeBucket();
        const database = new FakeHearts();
        const older = catsKey(1);
        const newer = catsKey(2);
        bucket.add(older);
        bucket.add(newer);
        bucket.add(catsKey(3));
        database.heart(older, VISITOR);
        database.heart(newer, "visitor-other");

        const { entries } = await runLeaderboard(bucket, database);

        expect(entries.map((entry) => entry.photo.key)).toEqual([newer, older]);
        expect(entries.map((entry) => entry.rank)).toEqual([1, 2]);
        expect(entries.map((entry) => entry.photo.hearted)).toEqual([false, true]);
        expect(entries.map((entry) => entry.photo.url)).toEqual([
            `https://${ASSETS_HOST}/${newer}`,
            `https://${ASSETS_HOST}/${older}`,
        ]);
    });

    it("returns no entries when every hearted photo is gone from the bucket", async () => {
        const bucket = new FakeBucket();
        const database = new FakeHearts();
        const deleted = catsKey(1);
        database.heart(deleted, VISITOR);
        bucket.add(catsKey(2));

        const { entries } = await runLeaderboard(bucket, database);

        expect(entries).toEqual([]);
    });
});
