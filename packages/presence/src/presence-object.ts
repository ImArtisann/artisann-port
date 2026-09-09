import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { PRESENCE_SNAPSHOT_KEY, PRESENCE_STALE_AFTER_MS } from "./config.ts";
import { ApiUnavailable } from "./api-errors.ts";
import { IsoTimestamp } from "./content.ts";
import { withFreshness } from "./presence.ts";
import { PresenceSnapshot, UNINITIALIZED_SNAPSHOT } from "./schema.ts";
import type { PresenceKvBinding } from "./store.ts";

/**
 * The small subset of native Durable Object storage used by presence.
 *
 * Presence deliberately stores the JSON representation rather than an object:
 * this makes the value an explicit, schema-validated document and keeps it
 * compatible with the legacy KV representation during the one-time migration.
 */
export interface PresenceStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    setAlarm(alarm: number | Date): Promise<void>;
}

/** A hibernatable WebSocket attachment as seen by the controller. */
export interface PresenceSocket {
    send(message: string): void;
    close(code?: number, reason?: string): void;
}

const unavailable = (operation: string): ApiUnavailable => new ApiUnavailable({ operation });
const isUnavailable = Schema.is(ApiUnavailable);

const SnapshotDocument = Schema.fromJsonString(PresenceSnapshot);
const decodeStoredSnapshot = Schema.decodeUnknownEffect(SnapshotDocument);
const encodeStoredSnapshot = Schema.encodeEffect(SnapshotDocument);
const decodeSnapshot = Schema.decodeUnknownEffect(PresenceSnapshot);
const decodeObservationTime = Schema.decodeUnknownEffect(IsoTimestamp);

function epochNow(): number {
    return DateTime.toEpochMillis(DateTime.nowUnsafe());
}

function freshProjection(snapshot: PresenceSnapshot, now: number): PresenceSnapshot {
    return withFreshness(snapshot, DateTime.toDateUtc(DateTime.makeUnsafe(now)));
}

/**
 * Authoritative presence Durable Object controller.
 *
 * Every operation, including native socket acceptance and initial send, runs
 * under one semaphore permit. The permit is released after both success and
 * failure so a transient unavailable storage operation cannot poison all
 * future invocations. No fiber remains between native workerd invocations.
 */
export class PresenceController {
    private readonly lock = Semaphore.makeUnsafe(1);

    constructor(
        private readonly storage: PresenceStorage,
        private readonly legacy: PresenceKvBinding,
        private readonly peers: () => ReadonlyArray<PresenceSocket>,
        private readonly now: () => number = epochNow,
    ) {}

    private run<A>(effect: Effect.Effect<A, ApiUnavailable>): Promise<A> {
        return Effect.runPromise(this.lock.withPermits(1)(effect));
    }

    /**
     * Read the DO document, migrating the old KV value only when the DO has
     * never been initialized. A failed KV read does not write an initialization
     * marker, so a later invocation can retry the migration.
     */
    private ensureInitialized(operation: string): Effect.Effect<PresenceSnapshot, ApiUnavailable> {
        return Effect.gen({ self: this }, function* () {
            const stored = yield* Effect.tryPromise({
                try: () => this.storage.get<unknown>(PRESENCE_SNAPSHOT_KEY),
                catch: () => unavailable(operation),
            });
            if (stored !== undefined) {
                return yield* decodeStoredSnapshot(stored).pipe(
                    Effect.mapError(() => unavailable(operation)),
                );
            }

            const legacyValue = yield* Effect.tryPromise({
                try: () => this.legacy.get(PRESENCE_SNAPSHOT_KEY),
                catch: () => unavailable(operation),
            });

            let initial = UNINITIALIZED_SNAPSHOT;
            if (legacyValue != null) {
                initial = yield* decodeStoredSnapshot(legacyValue).pipe(
                    Effect.orElseSucceed(() => UNINITIALIZED_SNAPSHOT),
                );
            }

            const encoded = yield* encodeStoredSnapshot(initial).pipe(
                Effect.mapError(() => unavailable(operation)),
            );
            yield* Effect.tryPromise({
                try: () => this.storage.put(PRESENCE_SNAPSHOT_KEY, encoded),
                catch: () => unavailable(operation),
            });
            return initial;
        });
    }

    private broadcast(
        snapshot: PresenceSnapshot,
        operation: string,
    ): Effect.Effect<void, ApiUnavailable> {
        return encodeStoredSnapshot(snapshot).pipe(
            Effect.mapError(() => unavailable(operation)),
            Effect.flatMap((message) =>
                Effect.try({
                    try: () => {
                        // This is intentionally discovered on every fanout. Native
                        // hibernation can reconstruct a DO after the controller is gone.
                        const sockets = this.peers();
                        for (const socket of sockets) {
                            try {
                                socket.send(message);
                            } catch {
                                // One broken attachment must not suppress the committed value
                                // for any other visitor. Native close/error cleanup owns the
                                // attachment's eventual removal.
                            }
                        }
                    },
                    catch: () => unavailable(operation),
                }),
            ),
        );
    }

    getSnapshot(): Promise<PresenceSnapshot> {
        return this.run(
            Effect.gen({ self: this }, function* () {
                const snapshot = yield* this.ensureInitialized("presence.get");
                return freshProjection(snapshot, this.now());
            }).pipe(Effect.withSpan("Presence.getSnapshot")),
        );
    }

    publishSnapshot(snapshot: PresenceSnapshot): Promise<PresenceSnapshot> {
        return this.run(
            Effect.gen({ self: this }, function* () {
                const validated = yield* decodeSnapshot(snapshot).pipe(
                    Effect.mapError(() => unavailable("presence.publish")),
                );
                // PresenceSnapshot intentionally accepts a non-empty string for
                // stored data; publication is stricter and requires canonical ISO.
                const observationTime = yield* decodeObservationTime(validated.updatedAt).pipe(
                    Effect.mapError(() => unavailable("presence.publish")),
                );

                const current = yield* this.ensureInitialized("presence.publish");
                const observedAt = Date.parse(observationTime);
                const now = this.now();
                if (!Number.isFinite(now) || !Number.isFinite(observedAt)) {
                    return yield* unavailable("presence.publish");
                }

                const canonical = {
                    ...validated,
                    // `stale` is a reader projection, never an observation fact.
                    stale: false,
                    updatedAt:
                        observedAt > now
                            ? DateTime.formatIso(DateTime.makeUnsafe(now))
                            : observationTime,
                } satisfies PresenceSnapshot;
                const currentAt = current.updatedAt === null ? null : Date.parse(current.updatedAt);
                const canonicalAt = Date.parse(canonical.updatedAt);

                // Retries of an older observation must not renew liveness or overwrite
                // a newer song. Equal timestamps are intentionally accepted.
                if (currentAt !== null && Number.isFinite(currentAt) && canonicalAt < currentAt) {
                    return freshProjection(current, now);
                }

                const encoded = yield* encodeStoredSnapshot(canonical).pipe(
                    Effect.mapError(() => unavailable("presence.publish")),
                );
                yield* Effect.tryPromise({
                    try: () => this.storage.put(PRESENCE_SNAPSHOT_KEY, encoded),
                    catch: () => unavailable("presence.publish"),
                });
                yield* Effect.tryPromise({
                    try: () => this.storage.setAlarm(canonicalAt + PRESENCE_STALE_AFTER_MS + 1),
                    catch: () => unavailable("presence.alarm"),
                });
                yield* this.broadcast(freshProjection(canonical, now), "presence.publish");
                return canonical;
            }).pipe(Effect.withSpan("Presence.publishSnapshot")),
        );
    }

    connect(socket: PresenceSocket, accept: () => void): Promise<void> {
        return this.run(
            Effect.gen({ self: this }, function* () {
                const snapshot = yield* this.ensureInitialized("presence.connect");
                const projection = freshProjection(snapshot, this.now());
                if (!projection.stale && projection.updatedAt !== null) {
                    const updatedAt = projection.updatedAt;
                    // A migrated legacy observation may not have a native alarm yet.
                    yield* Effect.tryPromise({
                        try: () =>
                            this.storage.setAlarm(
                                Date.parse(updatedAt) + PRESENCE_STALE_AFTER_MS + 1,
                            ),
                        catch: () => unavailable("presence.connect"),
                    });
                }
                const message = yield* encodeStoredSnapshot(projection).pipe(
                    Effect.mapError(() => unavailable("presence.connect")),
                );
                // Native accept registers the attachment with hibernation. It must
                // happen inside the same permit as the first read/send, after the
                // authority has been read so a failed initialization leaves no
                // accepted socket behind.
                yield* Effect.try({
                    try: () => {
                        accept();
                        socket.send(message);
                    },
                    catch: (error) =>
                        isUnavailable(error) ? error : unavailable("presence.connect"),
                });
            }).pipe(Effect.withSpan("Presence.connect")),
        );
    }

    alarm(): Promise<void> {
        return this.run(
            Effect.gen({ self: this }, function* () {
                const current = yield* this.ensureInitialized("presence.alarm");
                const now = this.now();
                if (!Number.isFinite(now)) return yield* unavailable("presence.alarm");

                const projection = freshProjection(current, now);
                if (!projection.stale && projection.updatedAt !== null) {
                    const deadline = Date.parse(projection.updatedAt) + PRESENCE_STALE_AFTER_MS + 1;
                    if (!Number.isFinite(deadline)) return yield* unavailable("presence.alarm");
                    yield* Effect.tryPromise({
                        try: () => this.storage.setAlarm(deadline),
                        catch: () => unavailable("presence.alarm"),
                    });
                    return;
                }

                // Alarm work reads the current authority and broadcasts its stale
                // projection. There is no in-memory timer or long-lived fiber.
                yield* this.broadcast(projection, "presence.alarm");
            }).pipe(Effect.withSpan("Presence.alarm")),
        );
    }
}
