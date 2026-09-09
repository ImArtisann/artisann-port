import { decodePresenceDocument, type PresenceSnapshot } from "@artisann-port/presence/schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Socket from "effect/unstable/socket/Socket";
import { useAtomValue } from "@effect/atom-react";
import { portfolioApiEndpoints } from "@/lib/rpc-client";

export interface PresenceState {
    /** Last snapshot received from the endpoint, or `null` before the first valid message. */
    readonly snapshot: PresenceSnapshot | null;
    /** `false` until the first valid snapshot or connection failure. */
    readonly settled: boolean;
    /** `true` after a socket error, close, or malformed snapshot. */
    readonly failed: boolean;
}

const INITIAL_STATE: PresenceState = { snapshot: null, settled: false, failed: false };

const reconnectSchedule = Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
);

/**
 * Connects to the hibernatable presence endpoint for each mounted source atom.
 * Every message is a complete snapshot, not a delta. The callback queue keeps
 * only the latest snapshot instead of replaying old playback after a slow render.
 */
const presenceStream = (endpoint: string, publishFailure: (state: PresenceState) => void) =>
    Stream.suspend(() => {
        let snapshot: PresenceSnapshot | null = null;
        const attempt = Stream.callback<PresenceSnapshot, Socket.SocketError | Schema.SchemaError>(
            (queue) =>
                Effect.gen(function* () {
                    // makeWebSocket uses Effect.map/sync for construction/close in
                    // rc.112. Supply typed acquisition and best-effort release instead.
                    const socket = yield* Socket.fromWebSocket(
                        Effect.acquireRelease(
                            Effect.try({
                                try: () => {
                                    const ws = new WebSocket(endpoint);
                                    ws.binaryType = "arraybuffer";
                                    return ws;
                                },
                                catch: (cause) =>
                                    new Socket.SocketError({
                                        reason: new Socket.SocketOpenError({
                                            kind: "Unknown",
                                            cause,
                                        }),
                                    }),
                            }),
                            (ws) =>
                                // A failed opening handshake can make native close throw.
                                Effect.ignore(Effect.try(() => ws.close(1000))),
                        ),
                        // Preserve the existing no-deadline connection contract.
                        // Quiet feeds have no periodic server heartbeat.
                        { openTimeout: Duration.infinity },
                    );
                    yield* socket.runRaw((frame) =>
                        decodePresenceDocument(frame).pipe(
                            Effect.flatMap((value) => Queue.offer(queue, value)),
                        ),
                    );
                }).pipe(Queue.into(queue)),
            { bufferSize: 1, strategy: "sliding" },
        );
        return attempt.pipe(
            Stream.tap((value) =>
                Effect.sync(() => {
                    snapshot = value;
                }),
            ),
            // Failure status bypasses the snapshot stream: Stream.retry resets
            // its schedule on emission, so failures must never be emitted here.
            Stream.tapError(() =>
                Effect.sync(() => publishFailure({ snapshot, settled: true, failed: true })),
            ),
            Stream.retry(reconnectSchedule),
            Stream.map((value): PresenceState => ({
                snapshot: value,
                settled: true,
                failed: false,
            })),
        );
    });

export const presenceAtom = Atom.family((endpoint: string) => {
    const source = Atom.make(
        (get) => presenceStream(endpoint, (state) => get.setSelf(AsyncResult.success(state))),
        { initialValue: INITIAL_STATE },
    ).pipe(Atom.setIdleTTL(0));
    const state = Atom.setIdleTTL(
        Atom.map(source, (result) => {
            const available = AsyncResult.getOrElse(result, () => INITIAL_STATE);
            return AsyncResult.isFailure(result)
                ? { snapshot: available.snapshot, settled: true, failed: true }
                : available;
        }),
        0,
    );

    // Keep this as the final transform: getServerValue must not evaluate the
    // socket stream while Astro renders an SSR root.
    return Atom.withServerValue(state, () => INITIAL_STATE);
});

/**
 * Shared WebSocket state for consumers in the same registry and endpoint. The atom
 * family is keyed by the injectable WebSocket endpoint, not by component.
 */
export const usePresence = (endpoint: string = portfolioApiEndpoints.presenceUrl): PresenceState =>
    useAtomValue(presenceAtom(endpoint));
