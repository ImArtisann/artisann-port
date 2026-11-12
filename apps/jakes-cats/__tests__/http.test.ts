import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import { handleCatsRequest } from "../src/server/http.ts";
import { MigrationService } from "../src/server/migration-service.ts";
import { PHOTO_A, VISITOR_A, VISITOR_B } from "./cats-world.ts";
import { uploadWorld } from "./upload-world.ts";

it("gates migration, preserves the cookie across JSON actions and redacts private failures and identities", async () => {
    const world = uploadWorld();
    const token = Redacted.make("writer-test-token");
    const migrationRequest = (operation: string, authorized: boolean) =>
        new Request(`https://jakes.cat/api/migration/${operation}`, {
            method: "POST",
            headers: authorized ? { authorization: "Bearer writer-test-token" } : {},
        });
    const action = (path: string, visitor: string, body: Schema.Json) =>
        new Request(`https://jakes.cat${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `jc_visitor=${visitor}` },
            body: JSON.stringify(body),
        });
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                expect(
                    (yield* handleCatsRequest(migrationRequest("prepare", false), token)).status,
                ).toBe(401);
                expect(
                    (yield* handleCatsRequest(migrationRequest("prepare", true), token)).status,
                ).toBe(200);
                expect(
                    (yield* handleCatsRequest(migrationRequest("fence", true), token)).status,
                ).toBe(200);
                expect(
                    (yield* handleCatsRequest(migrationRequest("handoff", true), token)).status,
                ).toBe(200);
                const minted = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/deck"),
                    token,
                );
                expect(minted.headers.get("set-cookie")).toContain("HttpOnly");
                expect(
                    (yield* handleCatsRequest(
                        action("/api/hearts", VISITOR_A, { key: PHOTO_A }),
                        token,
                    )).status,
                ).toBe(200);
                const repeat = yield* handleCatsRequest(
                    action("/api/hearts", VISITOR_A, { key: PHOTO_A }),
                    token,
                );
                expect(yield* Effect.promise(() => repeat.json())).toEqual({
                    key: PHOTO_A,
                    likes: 1,
                    hearted: true,
                });
                const accepted = yield* handleCatsRequest(
                    action("/api/comments", VISITOR_A, { key: PHOTO_A, body: "A friendly cat" }),
                    token,
                );
                expect(accepted.status).toBe(200);
                const other = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/photo/123456789012345678", {
                        headers: { cookie: `jc_visitor=${VISITOR_B}` },
                    }),
                    token,
                );
                const detail = yield* Effect.promise(() => other.text());
                expect(detail).toContain('"mine":false');
                expect(detail).not.toContain(VISITOR_A);
                expect(detail).not.toContain(VISITOR_B);
                world.moderation.unavailable = true;
                const failed = yield* handleCatsRequest(
                    action("/api/comments", VISITOR_B, {
                        key: PHOTO_A,
                        body: "Should fail closed",
                    }),
                    token,
                );
                expect(failed.status).toBe(503);
                expect(yield* Effect.promise(() => failed.json())).toEqual({
                    message: "Comments unavailable",
                });
                world.limits.allowed = false;
                const limited = yield* handleCatsRequest(
                    action("/api/hearts", VISITOR_B, { key: PHOTO_A }),
                    token,
                );
                expect(limited.status).toBe(429);
                expect(yield* Effect.promise(() => limited.json())).toEqual({
                    message: "Rate limited",
                });
                const missing = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/photo/not-managed"),
                    token,
                );
                expect(missing.status).toBe(404);
                expect(yield* Effect.promise(() => missing.json())).toEqual({
                    message: "Unknown photo",
                });
                const top = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/top"),
                    token,
                );
                expect(top.status).toBe(200);
                expect(yield* Effect.promise(() => top.text())).toContain('"likes":1');
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});

it("refuses an unprojected heart and its no-op repeat, then recovers without inflating hearts", async () => {
    const world = uploadWorld();
    const token = Redacted.make("writer-test-token");
    const projectionAttempted = Promise.withResolvers<void>();
    world.db.beforeWrite = async (sql) => {
        if (!sql.startsWith("INSERT INTO cats_domain_hearts")) return;
        projectionAttempted.resolve();
        throw new Error("Injected projection storage outage");
    };
    const heartRequest = (visitor: string) =>
        new Request("https://jakes.cat/api/hearts", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `jc_visitor=${visitor}` },
            body: JSON.stringify({ key: PHOTO_A }),
        });
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                yield* migration.prepare;
                yield* migration.fence;
                yield* migration.handoff;
                const pending = yield* handleCatsRequest(heartRequest(VISITOR_A), token).pipe(
                    Effect.forkScoped,
                );
                yield* Effect.promise(() => projectionAttempted.promise);
                yield* TestClock.adjust("1 minute");
                const failed = yield* Fiber.join(pending);
                expect(failed.status).toBe(503);
                expect(yield* Effect.promise(() => failed.json())).toEqual({
                    message: "Hearts unavailable",
                });
                const repeat = yield* handleCatsRequest(heartRequest(VISITOR_A), token);
                expect(repeat.status).toBe(503);
                expect(
                    world.db.sqlite
                        .prepare("SELECT COUNT(*) AS count FROM cats_domain_hearts")
                        .get(),
                ).toEqual({ count: 0 });
                world.db.beforeWrite = undefined;
                const recovering = yield* handleCatsRequest(heartRequest(VISITOR_B), token).pipe(
                    Effect.forkScoped,
                );
                yield* TestClock.adjust("1 minute");
                const recovered = yield* Fiber.join(recovering);
                expect(recovered.status).toBe(200);
                expect(yield* Effect.promise(() => recovered.json())).toEqual({
                    key: PHOTO_A,
                    likes: 2,
                    hearted: true,
                });
                const confirmed = yield* handleCatsRequest(heartRequest(VISITOR_A), token);
                expect(yield* Effect.promise(() => confirmed.json())).toEqual({
                    key: PHOTO_A,
                    likes: 2,
                    hearted: true,
                });
                const top = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/top"),
                    token,
                );
                expect(yield* Effect.promise(() => top.text())).toContain('"likes":2');
            }).pipe(Effect.scoped, Effect.provide(world.layer), Effect.provide(TestClock.layer())),
        );
    } finally {
        world.db.sqlite.close();
    }
});
