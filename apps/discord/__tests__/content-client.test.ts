import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import { MemoryRateLimitStoreLive, RateLimiterLive } from "dfx/RateLimit";
import { ApiUnavailable, ContentWriteError } from "@artisann-port/presence/api-errors";
import { DEFAULT_SITE_CONTENT } from "@artisann-port/presence/content";
import type { ContentWriterAction } from "@artisann-port/presence/content-writer";
import { PublicRpcs, WriterAuth, WriterRpcs } from "@artisann-port/presence/rpc";
import type {
    ContentWriterResult,
    ContentWriterState,
} from "@artisann-port/presence/content-writer";
import { BotRpcClients, ContentValidationError } from "../src/rpc-client.ts";
import {
    BotContentClient,
    BotContentClientLive,
    type NoteApproval,
} from "../src/content-client.ts";

const approval: NoteApproval = {
    id: "a".repeat(32),
    name: "RPC fixture",
    body: "An approved fixture note.",
    submittedAt: "2026-09-08T00:00:00.000Z",
};

const state = (revision = 1, publishedRevision = revision): ContentWriterState => ({
    revision,
    publishedRevision,
    content: DEFAULT_SITE_CONTENT,
});

type Call =
    | "content.state"
    | { readonly tag: "content.apply"; readonly action: ContentWriterAction };

interface FakeRpc {
    readonly layer: Layer.Layer<BotContentClient>;
    readonly calls: ReadonlyArray<Call>;
}

interface FakeRpcBehavior {
    readonly state: () => Effect.Effect<ContentWriterState, ApiUnavailable>;
    readonly apply: (
        action: ContentWriterAction,
    ) => Effect.Effect<ContentWriterResult, ApiUnavailable | ContentWriteError>;
}

const unavailable = (operation: string): Effect.Effect<never, ApiUnavailable> =>
    Effect.fail(new ApiUnavailable({ operation }));

const makeFakeRpc = (behavior: FakeRpcBehavior): FakeRpc => {
    const calls: Array<Call> = [];
    const writerHandlers = WriterRpcs.toLayer({
        "presence.get": () => unavailable("presence.get"),
        "presence.publish": () => unavailable("presence.publish"),
        "content.state": () => {
            calls.push("content.state");
            return behavior.state();
        },
        "content.apply": (action) => {
            calls.push({ tag: "content.apply", action });
            return behavior.apply(action);
        },
        "photos.upload": () => unavailable("photos.upload"),
        "photos.delete": () => unavailable("photos.delete"),
    });
    const publicHandlers = PublicRpcs.toLayer({
        "content.get": () => unavailable("content.get"),
        "photos.list": () => unavailable("photos.list"),
        "github.get": () => unavailable("github.get"),
        "weather.get": () => unavailable("weather.get"),
    });
    const writerAuth = Layer.succeed(WriterAuth, (effect) => effect);
    const rpcClients = Layer.effect(
        BotRpcClients,
        Effect.gen(function* () {
            const writer = yield* RpcTest.makeClient(WriterRpcs, { flatten: true });
            const publicClient = yield* RpcTest.makeClient(PublicRpcs, { flatten: true });
            return BotRpcClients.of({ writer, public: publicClient });
        }),
    ).pipe(Layer.provide(Layer.mergeAll(writerHandlers, publicHandlers, writerAuth)));
    const dependencies = Layer.mergeAll(
        rpcClients,
        RateLimiterLive.pipe(Layer.provide(MemoryRateLimitStoreLive)),
    );
    return {
        layer: BotContentClientLive.pipe(Layer.provide(dependencies)),
        calls,
    };
};

const run = <A, E>(rpc: FakeRpc, effect: Effect.Effect<A, E, BotContentClient>) =>
    effect.pipe(Effect.provide(rpc.layer));

const runValue = <A, E>(rpc: FakeRpc, effect: Effect.Effect<A, E, BotContentClient>) =>
    Effect.runPromise(run(rpc, effect));

const updated = (revision: number, publishedRevision = revision): ContentWriterResult => ({
    outcome: "updated",
    state: state(revision, publishedRevision),
});

describe("BotContentClient RPC boundary", () => {
    it.each(["deleted", "not-found"] as const)(
        "returns %s after confirmed note deletion",
        async (outcome) => {
            const rpc = makeFakeRpc({
                state: () => Effect.succeed(state()),
                apply: () => Effect.succeed({ outcome, state: state(2) }),
            });
            const result = await runValue(
                rpc,
                Effect.gen(function* () {
                    const client = yield* BotContentClient;
                    return yield* client.deleteNote(approval.id);
                }),
            );
            expect(result).toBe(outcome);
        },
    );

    it.each(["deleted", "not-found"] as const)(
        "refuses %s when publication remains unconfirmed",
        async (outcome) => {
            const rpc = makeFakeRpc({
                state: () => Effect.succeed(state()),
                apply: () => Effect.succeed({ outcome, state: state(2, 1) }),
            });
            const result = await runValue(
                rpc,
                Effect.result(
                    Effect.gen(function* () {
                        const client = yield* BotContentClient;
                        return yield* client.deleteNote(approval.id);
                    }),
                ),
            );
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { operation: "deleteNote", status: 503, reason: "Unavailable" },
            });
        },
    );

    it("rejects an unexpected deletion outcome", async () => {
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state()),
            apply: () => Effect.succeed(updated(2)),
        });
        const result = await runValue(
            rpc,
            Effect.result(
                Effect.gen(function* () {
                    const client = yield* BotContentClient;
                    return yield* client.deleteNote(approval.id);
                }),
            ),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { operation: "deleteNote", status: 503, reason: "Unavailable" },
        });
    });

    it("retries only a typed CAS conflict and then returns the confirmed projection", async () => {
        let applyCount = 0;
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state(1)),
            apply: () => {
                applyCount += 1;
                if (applyCount === 1)
                    return Effect.fail(new ContentWriteError({ kind: "conflict" }));
                return Effect.succeed(updated(2));
            },
        });
        const content = await runValue(
            rpc,
            Effect.gen(function* () {
                const client = yield* BotContentClient;
                return yield* client.updateContent((current) => Result.succeed(current));
            }),
        );
        expect(content).toEqual(DEFAULT_SITE_CONTENT);
        expect(applyCount).toBe(2);
    });

    it("does not retry a non-conflict content error", async () => {
        let applyCount = 0;
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state()),
            apply: () => {
                applyCount += 1;
                return Effect.fail(new ContentWriteError({ kind: "unavailable" }));
            },
        });
        const result = await Effect.runPromise(
            Effect.result(
                run(
                    rpc,
                    Effect.gen(function* () {
                        const client = yield* BotContentClient;
                        return yield* client.updateContent((current) => Result.succeed(current));
                    }),
                ),
            ),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(applyCount).toBe(1);
    });

    it("fails an update when the writer has not confirmed KV publication", async () => {
        let applyCount = 0;
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state()),
            apply: () => {
                applyCount += 1;
                return Effect.succeed(updated(2, 1));
            },
        });
        const result = await Effect.runPromise(
            Effect.result(
                run(
                    rpc,
                    Effect.gen(function* () {
                        const client = yield* BotContentClient;
                        return yield* client.updateContent((current) => Result.succeed(current));
                    }),
                ),
            ),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { operation: "updateContent", status: 503 },
        });
        expect(applyCount).toBe(1);
    });

    it("does not resend an approval after an ambiguous RPC failure", async () => {
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state()),
            apply: () => {
                return Effect.fail(new ApiUnavailable({ operation: "content.apply" }));
            },
        });
        const result = await Effect.runPromise(
            Effect.result(
                run(
                    rpc,
                    Effect.gen(function* () {
                        const client = yield* BotContentClient;
                        return yield* client.approveNote(approval);
                    }),
                ),
            ),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { operation: "approveNote", reason: "Unavailable" },
        });
        expect(rpc.calls.filter((call) => call !== "content.state")).toHaveLength(1);
    });

    it("bounds a stuck RPC operation to fifteen seconds", async () => {
        const rpc = makeFakeRpc({
            state: () => Effect.never,
            apply: () => Effect.never,
        });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const pending = yield* Effect.result(
                    run(
                        rpc,
                        Effect.gen(function* () {
                            const client = yield* BotContentClient;
                            return yield* client.loadContent;
                        }),
                    ),
                ).pipe(Effect.forkChild);
                yield* TestClock.adjust("16 seconds");
                return yield* Fiber.join(pending);
            }).pipe(Effect.provide(TestClock.layer())),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { operation: "loadContent", status: null, reason: "Timeout" },
        });
    });

    it("returns caller validation failures without an RPC mutation", async () => {
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state()),
            apply: () => Effect.die("unexpected mutation"),
        });
        const result = await Effect.runPromise(
            Effect.result(
                run(
                    rpc,
                    Effect.gen(function* () {
                        const client = yield* BotContentClient;
                        return yield* client.updateContent(() =>
                            Result.fail(new ContentValidationError({ message: "invalid" })),
                        );
                    }),
                ),
            ),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "Discord.ContentValidationError", message: "invalid" },
        });
        expect(rpc.calls.filter((call) => call !== "content.state")).toHaveLength(0);
    });

    it("deletes a note and returns deleted outcome on success", async () => {
        const testNoteId = "b".repeat(32);
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state(1, 1)),
            apply: (action) => {
                expect(action).toEqual({ action: "delete", id: testNoteId });
                return Effect.succeed({
                    outcome: "deleted",
                    state: state(2, 2),
                });
            },
        });
        const result = await Effect.runPromise(
            run(
                rpc,
                Effect.gen(function* () {
                    const client = yield* BotContentClient;
                    return yield* client.deleteNote(testNoteId);
                }),
            ),
        );
        expect(result).toBe("deleted");
        expect(rpc.calls).toContainEqual({
            tag: "content.apply",
            action: { action: "delete", id: testNoteId },
        });
    });

    it("returns not-found outcome when note does not exist", async () => {
        const testNoteId = "c".repeat(32);
        const rpc = makeFakeRpc({
            state: () => Effect.succeed(state(1, 1)),
            apply: (action) => {
                expect(action).toEqual({ action: "delete", id: testNoteId });
                return Effect.succeed({
                    outcome: "not-found",
                    state: state(1, 1),
                });
            },
        });
        const result = await Effect.runPromise(
            run(
                rpc,
                Effect.gen(function* () {
                    const client = yield* BotContentClient;
                    return yield* client.deleteNote(testNoteId);
                }),
            ),
        );
        expect(result).toBe("not-found");
    });
});
