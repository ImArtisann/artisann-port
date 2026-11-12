import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { WorkerEnvironment } from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Cats } from "@artisann-port/cats-domain/cats.model";
import { CatsInternalApi } from "@artisann-port/cats-domain/cats-internal.api";
import { DeckLive, PhotosBinding, PhotosConfig } from "../src/server/deck-service.ts";
import { HeartLive, RateLimitBinding } from "../src/server/heart-service.ts";
import {
    HeartsBinding,
    HeartsLive,
    type HeartsStatement,
    type HeartsD1Binding,
} from "../src/server/hearts-service.ts";
import { MigrationLive } from "../src/server/migration-service.ts";
import { ModerationService, ModerationError } from "../src/server/moderation-service.ts";
import { PhotoIndexLive } from "../src/server/photo-index.ts";
import type { PhotosR2ReadBinding } from "../src/env.ts";

const SqlValue = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
class SqlStatement implements HeartsStatement {
    private values: Array<string | number | null> = [];
    constructor(
        private readonly db: DatabaseSync,
        private readonly query: string,
        private readonly beforeWrite: (sql: string) => void | Promise<void>,
    ) {}
    bind(...values: unknown[]): SqlStatement {
        this.values = [...Schema.decodeUnknownSync(Schema.Array(SqlValue))(values)];
        return this;
    }
    all() {
        return Promise.resolve({ results: this.db.prepare(this.query).all(...this.values) });
    }
    first() {
        return Schema.decodeUnknownPromise(Schema.Json)(
            this.db.prepare(this.query).get(...this.values) ?? null,
        );
    }
    ready() {
        return this.beforeWrite(this.query);
    }
    execute() {
        this.db.prepare(this.query).run(...this.values);
        return { success: true };
    }
    async run() {
        await this.ready();
        return this.execute();
    }
}
export class SqliteD1 implements HeartsD1Binding {
    readonly sqlite = new DatabaseSync(":memory:");
    failCheckpointOnce = false;
    beforeWrite: ((sql: string) => Promise<void>) | undefined;
    prepare(query: string) {
        return new SqlStatement(this.sqlite, query, (sql) => {
            if (
                this.failCheckpointOnce &&
                sql.startsWith("UPDATE cats_migration SET checkpoint=")
            ) {
                this.failCheckpointOnce = false;
                throw new Error("Injected checkpoint storage outage");
            }
            return this.beforeWrite?.(sql);
        });
    }
    async batch(statements: ReadonlyArray<SqlStatement>) {
        await Promise.all(statements.map((statement) => statement.ready()));
        this.sqlite.exec("BEGIN");
        try {
            const results = statements.map((statement) => statement.execute());
            this.sqlite.exec("COMMIT");
            return results;
        } catch (error) {
            this.sqlite.exec("ROLLBACK");
            throw error;
        }
    }
}
export const PHOTO_A = "cats/123456789012345678.webp";
export const PHOTO_B = "cats/123456789012345679.webp";
export const VISITOR_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const VISITOR_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const ORIGINAL_TIME = "2026-01-02T03:04:05.000Z";

export function catsWorld() {
    const db = new SqliteD1();
    for (const file of [
        "0001_photo_likes.sql",
        "0002_visitors.sql",
        "0003_visitor_hearts_index.sql",
    ])
        db.sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    const installCapture = () =>
        db.sqlite.exec(
            readFileSync(new URL("../migrations/0004_domain_online.sql", import.meta.url), "utf8"),
        );
    const memory = InMemory.make();
    const settle = Effect.gen(function* () {
        do {
            yield* memory.control.drain;
            yield* Effect.yieldNow;
        } while (!(yield* memory.control.idle));
    });
    const objects = new Map<string, Date>([
        [PHOTO_A, new Date(ORIGINAL_TIME)],
        [PHOTO_B, new Date(ORIGINAL_TIME)],
    ]);
    const bucket: PhotosR2ReadBinding = {
        list: ({ prefix }) =>
            Promise.resolve({
                objects: [...objects]
                    .filter(([key]) => key.startsWith(prefix ?? ""))
                    .map(([key, uploaded]) => ({ key, uploaded })),
                truncated: false,
            }),
        head: (key) =>
            Promise.resolve(
                objects.has(key)
                    ? {
                          key,
                          version: "1",
                          size: 12,
                          etag: "etag",
                          httpEtag: '"etag"',
                          checksums: { toJSON: () => ({}) },
                          uploaded: new Date(ORIGINAL_TIME),
                          storageClass: "Standard",
                          writeHttpMetadata: () => undefined,
                      }
                    : null,
            ),
    };
    const moderationCalls: Array<string> = [];
    const moderation = { unavailable: false, profane: false, calls: moderationCalls };
    const limits = { allowed: true };
    const bindings = Layer.succeed(WorkerEnvironment, { LIKES: db });
    const platform = memory.layer.pipe(
        Layer.provide(Layer.effectDiscard(Effect.addFinalizer(() => settle))),
    );
    const model = Cats.layer(PhotoIndexLive).pipe(Layer.provide(platform));
    const capabilities = Layer.mergeAll(
        Layer.succeed(HeartsBinding, db),
        Layer.succeed(PhotosBinding, bucket),
        Layer.succeed(PhotosConfig, { assetsHost: "assets.example.com" }),
        Layer.succeed(RateLimitBinding, {
            limit: () => Promise.resolve({ success: limits.allowed }),
        }),
        Layer.succeed(ModerationService, {
            isProfane: (body) =>
                Effect.suspend(() => {
                    moderation.calls.push(body);
                    return moderation.unavailable
                        ? Effect.fail(new ModerationError({ reason: "Unavailable" }))
                        : Effect.succeed(moderation.profane);
                }),
        }),
        CatsInternalApi.layerClientInProcess.pipe(Layer.provideMerge(model)),
    );
    const storage = Layer.mergeAll(HeartsLive, MigrationLive).pipe(
        Layer.provideMerge(capabilities),
    );
    const configuredStorage = storage.pipe(Layer.provideMerge(bindings));
    const layer = Layer.mergeAll(DeckLive, HeartLive).pipe(Layer.provideMerge(configuredStorage));
    return { db, memory, settle, layer, objects, moderation, limits, installCapture };
}
