import { decodePresenceDocument, PresenceSnapshot } from "@artisann-port/presence/schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

export const PresenceState = Schema.Struct({
    snapshot: Schema.NullOr(PresenceSnapshot),
    settled: Schema.Boolean,
    failed: Schema.Boolean,
});
export type PresenceState = typeof PresenceState.Type;
export const INITIAL_PRESENCE: PresenceState = { snapshot: null, settled: false, failed: false };

const reconnectSchedule = Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
);

/** Failure changes availability without discarding the last valid song or snapshot. */
export const presenceStream = (endpoint: string): Stream.Stream<PresenceState> =>
    Stream.callback<PresenceState>(
        (states) => {
            let snapshot: PresenceSnapshot | null = null;
            return Stream.callback<PresenceSnapshot, Socket.SocketError | Schema.SchemaError>(
                (snapshots) =>
                    Effect.gen(function* () {
                        const socket = yield* Socket.fromWebSocket(
                            Effect.acquireRelease(
                                Effect.try({
                                    try: () => new WebSocket(endpoint),
                                    catch: (cause) =>
                                        new Socket.SocketError({
                                            reason: new Socket.SocketOpenError({
                                                kind: "Unknown",
                                                cause,
                                            }),
                                        }),
                                }),
                                (ws) =>
                                    Effect.try(() => ws.close(1000)).pipe(
                                        Effect.catch(() =>
                                            Effect.logWarning("presence: WebSocket close failed"),
                                        ),
                                    ),
                            ),
                            { openTimeout: Duration.infinity },
                        );
                        const { pull } = yield* socket.reader;
                        while (true) {
                            const frames = yield* pull;
                            let latest = yield* decodePresenceDocument(frames[0]);
                            for (let index = 1; index < frames.length; index++) {
                                latest = yield* decodePresenceDocument(frames[index]).pipe(
                                    Effect.tapError(() => Queue.offer(snapshots, latest)),
                                );
                            }
                            yield* Queue.offer(snapshots, latest);
                        }
                    }).pipe(Queue.into(snapshots)),
                { bufferSize: 1, strategy: "sliding" },
            ).pipe(
                Stream.tap((value) =>
                    Effect.sync(() => {
                        snapshot = value;
                    }),
                ),
                Stream.tapError(() =>
                    Queue.offer(states, { snapshot, settled: true, failed: true }),
                ),
                Stream.retry(reconnectSchedule),
                Stream.runForEach((value) =>
                    Queue.offer(states, {
                        snapshot: value,
                        settled: true,
                        failed: false,
                    }),
                ),
                Effect.orDie,
            );
        },
        { bufferSize: 1, strategy: "sliding" },
    );
