/**
 * Uncertainty-boundary tests for the presence worker, per the plan's test
 * contract. Authored against `makePresenceWorker` with an in-memory
 * persistence fake whose `savePresence` can be gated on a Deferred, so flush
 * coalescing and dirty/published version tracking are observable without
 * sleeping.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { withFreshness } from "@artisann-port/presence/presence";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";
import * as Fiber from "effect/Fiber";
import type { DiscordPresence } from "@artisann-port/presence/activity";
import {
    makePresenceWorker,
    type MemberChunkEvent,
    type PresenceEvent,
    type PresenceWorker,
} from "../src/presence.ts";
import { BotStorageError } from "../src/rpc-client.ts";
import type { BotPresenceClientService } from "../src/presence-client.ts";

const SERVER_ID = "100000000000000001";
const USER_ID = "200000000000000002";
const OTHER_USER_ID = "888000000000000008";
const OTHER_GUILD_ID = "999000000000000009";

const observedAt = new Date("2026-09-08T03:00:00.000Z");

const persistedSong: PresenceSnapshot = {
    status: "online",
    song: {
        title: "Persisted song",
        artist: "Persisted artist",
        url: "https://music.youtube.com/watch?v=persisted",
        artworkUrl: null,
    },
    playback: "playing",
    updatedAt: observedAt.toISOString(),
    stale: false,
};

const songPayload: DiscordPresence = {
    status: "online",
    activities: [
        {
            name: "YouTube Music",
            type: 2,
            details: "New song",
            state: "New artist",
            details_url: "https://music.youtube.com/watch?v=new",
        },
    ],
};

const presenceEvent = (
    payload: DiscordPresence,
    userId = USER_ID,
    guildId = SERVER_ID,
): PresenceEvent => ({
    kind: "presence",
    guildId,
    userId,
    payload,
});

const chunkEvent = (overrides: Partial<MemberChunkEvent>): PresenceEvent => ({
    kind: "chunk",
    chunk: {
        guildId: SERVER_ID,
        nonce: null,
        chunkIndex: 0,
        chunkCount: 1,
        memberIds: [],
        notFound: false,
        presenceUserId: USER_ID,
        presenceUnknown: false,
        presence: null,
        ...overrides,
    },
});

interface FakePresenceClient {
    readonly client: BotPresenceClientService;
    readonly writes: Ref.Ref<ReadonlyArray<PresenceSnapshot>>;
    readonly gate: Ref.Ref<Option.Option<Deferred.Deferred<void>>>;
    readonly saveStarted: Deferred.Deferred<void>;
}

const makeFakePresenceClient = Effect.fn("Test.makeFakePresenceClient")(function* (
    initial: PresenceSnapshot | null,
    readFailure: BotStorageError | null,
) {
    const writes = yield* Ref.make<ReadonlyArray<PresenceSnapshot>>([]);
    const gate = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    const saveStarted = yield* Deferred.make<void>();
    const loadPresence = readFailure === null ? Effect.succeed(initial) : Effect.fail(readFailure);
    const client: BotPresenceClientService = {
        loadPresence,
        savePresence: (snapshot) =>
            Effect.gen(function* () {
                yield* Deferred.succeed(saveStarted, undefined);
                const waiting = yield* Ref.get(gate);
                if (Option.isSome(waiting)) yield* Deferred.await(waiting.value);
                yield* Ref.update(writes, (list) => [...list, snapshot]);
            }),
    };
    return { client, writes, gate, saveStarted } satisfies FakePresenceClient;
});

const openGate = Effect.fn("Test.openGate")(function* (fake: FakePresenceClient) {
    const gate = yield* Deferred.make<void>();
    yield* Ref.set(fake.gate, Option.some(gate));
    return gate;
});

const releaseGate = Effect.fn("Test.releaseGate")(function* (fake: FakePresenceClient) {
    const waiting = yield* Ref.get(fake.gate);
    if (Option.isSome(waiting)) {
        yield* Deferred.succeed(waiting.value, undefined);
        yield* Ref.set(fake.gate, Option.none());
    }
});

/** Arm a request and return its nonce, failing the test when polling paused. */
const armRequest = Effect.fn("Test.armRequest")(function* (worker: PresenceWorker) {
    const armed = yield* worker.requestSnapshot;
    expect(Option.isSome(armed)).toBe(true);
    return Option.getOrElse(armed, () => "");
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromiseExit(Effect.scoped(effect));

describe("presence worker", () => {
    it("keeps the bootstrapped song as last-played when activities go empty", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(persistedSong, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                yield* worker.handle(presenceEvent({ status: "offline", activities: [] }));
                yield* worker.flush;
                const writes = yield* Ref.get(fake.writes);
                expect(writes).toHaveLength(1);
                expect(writes[0]?.song?.title).toBe("Persisted song");
                expect(writes[0]?.playback).toBe("last-played");
                expect(writes[0]?.status).toBe("offline");
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("fails startup and writes nothing when the bootstrap read fails", async () => {
        const writesSeen = { count: -1 };
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(
                    null,
                    new BotStorageError({
                        operation: "loadPresence",
                        status: null,
                        reason: "Store",
                    }),
                );
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* Effect.exit(worker.bootstrap).pipe(
                    Effect.flatMap((result) =>
                        Effect.sync(() => {
                            expect(Exit.isFailure(result)).toBe(true);
                        }),
                    ),
                );
                yield* worker.flush;
                const writes = yield* Ref.get(fake.writes);
                writesSeen.count = writes.length;
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(writesSeen.count).toBe(0);
    });

    it("retains a song observed before an empty event in one coalesced write", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                yield* worker.handle(presenceEvent(songPayload));
                yield* worker.handle(presenceEvent({ status: "online", activities: [] }));
                yield* worker.flush;
                const writes = yield* Ref.get(fake.writes);
                expect(writes).toHaveLength(1);
                expect(writes[0]?.song?.title).toBe("New song");
                expect(writes[0]?.playback).toBe("last-played");
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("does not publish a newer dirty version from a delayed write", async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const fake = yield* makeFakePresenceClient(null, null);
                    const worker = yield* makePresenceWorker({
                        client: fake.client,
                        serverId: SERVER_ID,
                        userId: USER_ID,
                    });
                    yield* worker.bootstrap;
                    yield* worker.handle(presenceEvent(songPayload));
                    yield* openGate(fake);
                    // The flush captures version 1 and blocks inside savePresence.
                    const flushing = yield* Effect.forkChild(worker.flush);
                    // Wait until the write has entered persistence. handle must
                    // proceed on the reducer mutex without waiting for the RPC.
                    yield* Deferred.await(fake.saveStarted);
                    const handling = yield* Effect.forkChild(
                        worker.handle(presenceEvent({ status: "dnd", activities: [] })),
                    );
                    yield* releaseGate(fake);
                    yield* Fiber.join(flushing);
                    yield* Fiber.join(handling);
                    // Version 2 arrived while version 1 was in flight, so the
                    // snapshot stays dirty and a later flush writes it too.
                    yield* worker.flush;
                    const writes = yield* Ref.get(fake.writes);
                    expect(writes).toHaveLength(2);
                    expect(writes[1]?.status).toBe("dnd");
                    expect(writes[1]?.song?.title).toBe("New song");
                }),
            ),
        );
    });

    it("ignores wrong guild, wrong user, and unmatched or stale nonces", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                yield* worker.handle(presenceEvent(songPayload, OTHER_USER_ID));
                yield* worker.handle(presenceEvent(songPayload, USER_ID, OTHER_GUILD_ID));
                // No request outstanding: an unsolicited chunk cannot be trusted.
                yield* worker.handle(
                    chunkEvent({
                        nonce: "unsolicited",
                        memberIds: [USER_ID],
                        presence: songPayload,
                    }),
                );
                // A superseded nonce: arm twice, answer the first.
                const first = yield* armRequest(worker);
                const second = yield* armRequest(worker);
                expect(first).not.toBe(second);
                yield* worker.handle(
                    chunkEvent({ nonce: first, memberIds: [USER_ID], presence: songPayload }),
                );
                yield* worker.flush;
                expect(yield* worker.snapshot).toBe(null);
                expect(yield* Ref.get(fake.writes)).toHaveLength(0);
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("treats a real push as superseding an outstanding request", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                const nonce = yield* armRequest(worker);
                yield* worker.handle(presenceEvent(songPayload));
                // The pending query was retired by the push; its late reply is void.
                yield* worker.handle(
                    chunkEvent({
                        nonce,
                        memberIds: [USER_ID],
                        presence: { status: "offline", activities: [] },
                    }),
                );
                const snapshot = yield* worker.snapshot;
                expect(snapshot?.status).toBe("online");
                expect(snapshot?.playback).toBe("playing");
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("separates a confirmed offline member from not_found and absent members", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;

                // not_found is unknown membership: nothing is written.
                const notFoundNonce = yield* armRequest(worker);
                yield* worker.handle(chunkEvent({ nonce: notFoundNonce, notFound: true }));
                expect(yield* worker.snapshot).toBe(null);

                // A chunk listing only other members is unknown too.
                const absentNonce = yield* armRequest(worker);
                yield* worker.handle(
                    chunkEvent({ nonce: absentNonce, memberIds: [OTHER_USER_ID] }),
                );
                expect(yield* worker.snapshot).toBe(null);

                // A presence owned by another member is not the target's status.
                const foreignNonce = yield* armRequest(worker);
                yield* worker.handle(
                    chunkEvent({
                        nonce: foreignNonce,
                        memberIds: [USER_ID],
                        presenceUserId: OTHER_USER_ID,
                        presence: { status: "dnd", activities: [] },
                    }),
                );
                expect(yield* worker.snapshot).toBe(null);

                // Presence data we cannot decode is unknown too, not offline.
                const malformedNonce = yield* armRequest(worker);
                yield* worker.handle(
                    chunkEvent({
                        nonce: malformedNonce,
                        memberIds: [USER_ID],
                        presenceUnknown: true,
                    }),
                );
                expect(yield* worker.snapshot).toBe(null);

                // A returned target member with no presence confirms offline.
                const offlineNonce = yield* armRequest(worker);
                yield* worker.handle(
                    chunkEvent({ nonce: offlineNonce, memberIds: [USER_ID], presence: null }),
                );
                const confirmed = yield* worker.snapshot;
                expect(confirmed?.status).toBe("offline");
                expect(confirmed?.playback).toBe("none");
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("rejects an incomplete multi-chunk reply instead of inventing membership", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                const nonce = yield* armRequest(worker);
                yield* worker.handle(
                    chunkEvent({
                        nonce,
                        chunkIndex: 0,
                        chunkCount: 2,
                        memberIds: [USER_ID],
                        presence: songPayload,
                    }),
                );
                expect(yield* worker.snapshot).toBe(null);
                expect(yield* Ref.get(fake.writes)).toHaveLength(0);
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("pauses confirmation while the target guild is unavailable", async () => {
        const exit = await run(
            Effect.gen(function* () {
                const fake = yield* makeFakePresenceClient(null, null);
                const worker = yield* makePresenceWorker({
                    client: fake.client,
                    serverId: SERVER_ID,
                    userId: USER_ID,
                });
                yield* worker.bootstrap;
                yield* worker.handle({ kind: "guild-unavailable", guildId: SERVER_ID });
                expect(Option.isNone(yield* worker.requestSnapshot)).toBe(true);
                // Another guild's availability changes nothing either way.
                yield* worker.handle({ kind: "guild-unavailable", guildId: OTHER_GUILD_ID });
                expect(Option.isNone(yield* worker.requestSnapshot)).toBe(true);
                yield* worker.handle({ kind: "guild-available", guildId: OTHER_GUILD_ID });
                expect(Option.isNone(yield* worker.requestSnapshot)).toBe(true);
                yield* worker.handle({ kind: "guild-available", guildId: SERVER_ID });
                expect(Option.isSome(yield* worker.requestSnapshot)).toBe(true);
                yield* worker.handle({ kind: "guild-unavailable", guildId: SERVER_ID });
                yield* worker.handle({ kind: "session-open" });
                expect(Option.isSome(yield* worker.requestSnapshot)).toBe(true);
            }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    it("expires a snapshot past the freshness window without fabricating status", () => {
        const stale = withFreshness(persistedSong, new Date(observedAt.getTime() + 151_000));
        expect(stale.stale).toBe(true);
        expect(stale.status).toBe(null);
        expect(stale.song?.title).toBe("Persisted song");
    });
});
