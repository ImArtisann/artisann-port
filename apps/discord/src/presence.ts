/**
 * The presence worker: the only writer of the presence snapshot after the
 * cutover.
 *
 * Every state transition runs through one ordered reducer. Gateway dispatches
 * arrive on a single `gateway.dispatch` stream consumed sequentially, and the
 * periodic confirmation request takes the same mutex, so no two fibers can
 * interleave a merge, a pending-nonce change, or a publish decision.
 *
 * Only confirmed data renews the snapshot: a live PRESENCE_UPDATE for the
 * configured user in the configured guild, or a nonce-matched single-chunk
 * GUILD_MEMBERS_CHUNK. `not_found`, an absent member, an unavailable guild, a
 * timed-out request, and a rejected send are all **unknown** — they renew
 * nothing and let the reader's freshness window expire the old observation
 * rather than fabricating an offline status.
 */
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
    DiscordPresence,
    type DiscordPresence as DiscordPresenceValue,
} from "@artisann-port/presence/activity";
import { mergePresence } from "@artisann-port/presence/presence";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";
import { DiscordGateway } from "dfx/DiscordGateway";
import * as SendEvent from "dfx/DiscordGateway/Shard/sendEvents";
import type * as Discord from "dfx/types";
import { BotConfig } from "./config.ts";
import { BotPresenceClient, type BotPresenceClientService } from "./presence-client.ts";
import { BotStorageError } from "./rpc-client.ts";

/** One GUILD_MEMBERS_CHUNK dispatch, narrowed before it reaches the reducer. */
export interface MemberChunkEvent {
    readonly guildId: string;
    readonly nonce: string | null;
    readonly chunkIndex: number;
    readonly chunkCount: number;
    /** User ids of the returned members. */
    readonly memberIds: ReadonlyArray<string>;
    /** `true` when Discord answered `not_found` for the requested id. */
    readonly notFound: boolean;
    /** Raw presence object for the targeted member, when one was returned. */
    readonly presence: DiscordPresenceValue | null;
}

/** Everything the ordered reducer accepts, transport-independent. */
export type PresenceEvent =
    /** READY or RESUMED: old nonces are void and confirmation reopens. */
    | { readonly kind: "session-open" }
    /** The target guild became available. */
    | { readonly kind: "guild-available"; readonly guildId: string }
    /** The target guild went away: pending request void, polling paused. */
    | { readonly kind: "guild-unavailable"; readonly guildId: string }
    | {
          readonly kind: "presence";
          readonly guildId: string;
          readonly userId: string;
          readonly payload: DiscordPresenceValue;
      }
    | { readonly kind: "chunk"; readonly chunk: MemberChunkEvent };

/** Worker construction dependencies; the typed presence client is injected. */
export interface PresenceWorkerOptions {
    readonly client: BotPresenceClientService;
    readonly serverId: string;
    readonly userId: string;
}

interface WorkerState {
    readonly snapshot: PresenceSnapshot | null;
    /** Bumped for every accepted observation; the dirty marker's identity. */
    readonly version: number;
    /** The version whose document storage actually accepted. */
    readonly publishedVersion: number;
    readonly dirty: boolean;
    /** Nonce of the outstanding targeted member request, if any. */
    readonly pendingNonce: string | null;
    /** `false` after a target GUILD_DELETE, until the guild returns. */
    readonly guildAvailable: boolean;
}

const INITIAL_STATE: WorkerState = {
    snapshot: null,
    version: 0,
    publishedVersion: 0,
    dirty: false,
    pendingNonce: null,
    guildAvailable: true,
};

/** A silent request must never renew anything; it expires unknown. */
const REQUEST_TIMEOUT = "15 seconds";

/** The dirty-flush cadence: one write of the latest merged snapshot. */
const FLUSH_INTERVAL = "2 seconds";

/** The targeted confirmation cadence. */
const CONFIRM_INTERVAL = "60 seconds";

/** A returned member with no presence at all confirms a real offline status. */
const OFFLINE_PRESENCE: DiscordPresence = { status: "offline", activities: [] };

export interface PresenceWorker {
    /** Seed the reducer from persisted state; a failed read must fail startup. */
    readonly bootstrap: Effect.Effect<void, BotStorageError>;
    /** Apply one event through the ordered reducer. */
    readonly handle: (event: PresenceEvent) => Effect.Effect<void>;
    /**
     * Arm a targeted member request, returning its nonce. `Option.none()` means
     * the target guild is unavailable and polling stays paused.
     */
    readonly requestSnapshot: Effect.Effect<Option.Option<string>, never, Scope.Scope>;
    /** The current reducer state, dirty or not. */
    readonly snapshot: Effect.Effect<PresenceSnapshot | null>;
    /** Write the dirty snapshot when one is waiting; failures keep it dirty. */
    readonly flush: Effect.Effect<void>;
}

/**
 * Build the presence worker over the presence domain client. Tests inject a
 * fake; production passes the scoped RPC client.
 */
export const makePresenceWorker = Effect.fn("Presence.makeWorker")(function* (
    options: PresenceWorkerOptions,
) {
    const cryptography = yield* Crypto.Crypto;
    const state = yield* Ref.make<WorkerState>(INITIAL_STATE);
    // One mutex for every state transition: dispatch reducer, timer-armed
    // requests, and flush publish decisions.
    const mutex = yield* Semaphore.make(1);

    const acceptObservation = (presence: DiscordPresence) =>
        Effect.gen(function* () {
            const observedAt = yield* DateTime.nowAsDate;
            yield* Ref.update(state, (current) => ({
                ...current,
                snapshot: mergePresence(current.snapshot, presence, observedAt),
                version: current.version + 1,
                dirty: true,
                // Any accepted observation retires the outstanding request, so a
                // late reply cannot overwrite newer truth.
                pendingNonce: null,
            }));
        });

    const reduce = (event: PresenceEvent) =>
        Effect.gen(function* () {
            switch (event.kind) {
                case "session-open": {
                    // Old nonces are void; confirmation reopens immediately.
                    yield* Ref.update(state, (current) => ({
                        ...current,
                        pendingNonce: null,
                        guildAvailable: true,
                    }));
                    return;
                }
                case "guild-available": {
                    if (event.guildId !== options.serverId) return;
                    yield* Ref.update(state, (current) => ({
                        ...current,
                        pendingNonce: null,
                        guildAvailable: true,
                    }));
                    return;
                }
                case "guild-unavailable": {
                    if (event.guildId !== options.serverId) return;
                    // Unknown, not offline: stop confirming until it returns.
                    yield* Ref.update(state, (current) => ({
                        ...current,
                        pendingNonce: null,
                        guildAvailable: false,
                    }));
                    return;
                }
                case "presence": {
                    if (event.guildId !== options.serverId || event.userId !== options.userId)
                        return;
                    yield* acceptObservation(event.payload);
                    return;
                }
                case "chunk": {
                    const chunk = event.chunk;
                    if (chunk.guildId !== options.serverId) return;
                    const current = yield* Ref.get(state);
                    if (chunk.nonce === null || chunk.nonce !== current.pendingNonce) return;
                    if (chunk.chunkIndex !== 0 || chunk.chunkCount !== 1) {
                        yield* Effect.logError(
                            "Presence: rejecting an unexpected multi-chunk member response",
                        );
                        return;
                    }
                    // The request is answered either way; consume it first.
                    yield* Ref.update(state, (pending) => ({ ...pending, pendingNonce: null }));
                    if (chunk.notFound) {
                        // `not_found` is unknown membership, never offline.
                        yield* Effect.logDebug(
                            "Presence: targeted member request returned not_found",
                        );
                        return;
                    }
                    if (!chunk.memberIds.includes(options.userId)) {
                        // An absent member is unknown, not offline.
                        return;
                    }
                    if (chunk.presence === null || chunk.presence === undefined) {
                        // A returned member with no presence confirms offline.
                        yield* acceptObservation(OFFLINE_PRESENCE);
                        return;
                    }
                    yield* acceptObservation(chunk.presence);
                    return;
                }
            }
        });

    const flush = mutex.withPermits(1)(
        Effect.gen(function* () {
            const before = yield* Ref.get(state);
            if (!before.dirty || before.snapshot === null) return;
            const captured = before.snapshot;
            const capturedVersion = before.version;
            const result = yield* Effect.exit(options.client.savePresence(captured));
            if (Exit.isFailure(result)) {
                yield* Effect.logWarning(
                    "Presence: storage rejected the snapshot write; it stays dirty",
                    result.cause,
                );
                return;
            }
            yield* Ref.update(state, (current) =>
                current.version === capturedVersion
                    ? { ...current, publishedVersion: capturedVersion, dirty: false }
                    : current,
            );
        }),
    );

    const requestSnapshot = Effect.gen(function* () {
        const armed = yield* mutex.withPermits(1)(
            Effect.gen(function* () {
                const current = yield* Ref.get(state);
                if (!current.guildAvailable) return Option.none<string>();
                const nonce = (yield* cryptography.randomUUIDv4.pipe(Effect.orDie)).replaceAll(
                    "-",
                    "",
                );
                yield* Ref.set(state, { ...current, pendingNonce: nonce });
                return Option.some(nonce);
            }),
        );
        if (Option.isNone(armed)) return armed;
        const nonce = armed.value;
        // A silent request expires unknown; it never changes updatedAt.
        yield* Effect.forkScoped(
            Effect.gen(function* () {
                yield* Effect.sleep(REQUEST_TIMEOUT);
                yield* mutex.withPermits(1)(
                    Ref.update(state, (current) =>
                        current.pendingNonce === nonce
                            ? { ...current, pendingNonce: null }
                            : current,
                    ),
                );
            }),
        );
        return armed;
    });

    return {
        bootstrap: Effect.gen(function* () {
            const persisted = yield* options.client.loadPresence;
            yield* Ref.set(state, { ...INITIAL_STATE, snapshot: persisted });
        }),
        handle: (event) => mutex.withPermits(1)(reduce(event)),
        requestSnapshot,
        snapshot: Effect.map(Ref.get(state), (current) => current.snapshot),
        flush,
    } satisfies PresenceWorker;
}, Effect.provide(BunCrypto.layer));

/** Map one raw Gateway dispatch onto a reducer event, or ignore it. */
const toPresenceEvent = (payload: Discord.GatewayReceivePayload): PresenceEvent | null => {
    if (!("t" in payload) || payload.t === null || payload.t === undefined) return null;
    switch (payload.t) {
        case "READY":
        case "RESUMED":
            return { kind: "session-open" };
        case "GUILD_CREATE": {
            const guild = payload.d;
            const unavailable = "unavailable" in guild ? guild.unavailable === true : false;
            return unavailable
                ? { kind: "guild-unavailable", guildId: guild.id }
                : { kind: "guild-available", guildId: guild.id };
        }
        case "GUILD_DELETE":
            return { kind: "guild-unavailable", guildId: payload.d.id };
        case "PRESENCE_UPDATE":
            return Option.match(Schema.decodeUnknownOption(DiscordPresence)(payload.d), {
                onNone: () => null,
                onSome: (presence) => ({
                    kind: "presence",
                    guildId: payload.d.guild_id,
                    userId: payload.d.user.id,
                    payload: presence,
                }),
            });
        case "GUILD_MEMBERS_CHUNK": {
            const rawPresence = payload.d.presences?.[0];
            const presence =
                rawPresence === undefined
                    ? null
                    : Option.getOrNull(Schema.decodeUnknownOption(DiscordPresence)(rawPresence));
            return {
                kind: "chunk",
                chunk: {
                    guildId: payload.d.guild_id,
                    nonce: payload.d.nonce ?? null,
                    chunkIndex: payload.d.chunk_index,
                    chunkCount: payload.d.chunk_count,
                    memberIds: payload.d.members.flatMap((member) =>
                        member.user?.id === undefined ? [] : [member.user.id],
                    ),
                    notFound: (payload.d.not_found?.length ?? 0) > 0,
                    presence,
                },
            };
        }
        default:
            return null;
    }
};

/**
 * Run the worker against the real Gateway: bootstrap first (a failed read
 * fails layer acquisition and therefore startup), then consume one ordered
 * dispatch stream, flush dirty snapshots every two seconds, and re-confirm the
 * target member every sixty seconds. Loop failures are logged with their cause
 * and retried on a bounded cadence instead of dying unobserved.
 */
export const PresenceWorkerLive: Layer.Layer<
    never,
    BotStorageError,
    DiscordGateway | BotPresenceClient | BotConfig
> = Layer.effectDiscard(
    Effect.gen(function* () {
        const gateway = yield* DiscordGateway;
        const client = yield* BotPresenceClient;
        const config = yield* BotConfig;
        const worker = yield* makePresenceWorker({
            client,
            serverId: config.serverId,
            userId: config.userId,
        });

        // Bootstrap before any subscription so an event cannot land first.
        yield* worker.bootstrap;

        const requestAndSend = Effect.gen(function* () {
            const armed = yield* worker.requestSnapshot;
            if (Option.isNone(armed)) return;
            const accepted = yield* gateway.send(
                SendEvent.requestGuildMembers({
                    guild_id: config.serverId,
                    user_ids: [config.userId],
                    presences: true,
                    nonce: armed.value,
                }),
            );
            if (!accepted) {
                // Queue rejection is not a confirmation and not an outage
                // verdict: the pending request simply expires unknown.
                yield* Effect.logWarning("Presence: the shard did not accept the member request");
            }
        });

        const reducerLoop = gateway.dispatch.pipe(
            Stream.runForEach((payload) => {
                const event = toPresenceEvent(payload);
                if (event === null) return Effect.void;
                return Effect.flatMap(worker.handle(event), () =>
                    event.kind === "session-open" || event.kind === "guild-available"
                        ? requestAndSend
                        : Effect.void,
                );
            }),
        );

        const supervise =
            (label: string) =>
            <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                    Effect.tapCause((cause) => Effect.logError(`Presence: ${label} failed`, cause)),
                    Effect.retry(Schedule.spaced("5 seconds")),
                );

        yield* Effect.forkScoped(supervise("dispatch reducer")(reducerLoop));
        yield* Effect.forkScoped(
            supervise("flush loop")(
                worker.flush.pipe(Effect.repeat(Schedule.spaced(FLUSH_INTERVAL))),
            ),
        );
        yield* Effect.forkScoped(
            supervise("confirmation loop")(
                requestAndSend.pipe(Effect.repeat(Schedule.spaced(CONFIRM_INTERVAL))),
            ),
        );
    }),
);
