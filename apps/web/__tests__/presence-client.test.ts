import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import {
    INITIAL_PRESENCE,
    presenceStream,
    type PresenceState,
} from "../src/lib/presence-client.ts";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";

const fibers: Fiber.Fiber<void>[] = [];
const sockets: LocalSocket[] = [];
const snapshot: PresenceSnapshot = {
    status: "online",
    song: {
        title: "Retained track",
        artist: "Fixture artist",
        url: "https://music.youtube.com/watch?v=fixture",
        artworkUrl: null,
    },
    playback: "playing",
    updatedAt: "2026-09-09T00:00:00.000Z",
    stale: false,
};
class LocalSocket extends EventTarget {
    static rejectConstruction = false;
    readyState = 0;
    binaryType = "blob";
    closed = false;
    rejectClose = false;
    constructor(readonly url: string) {
        super();
        if (LocalSocket.rejectConstruction) throw new Error("constructor unavailable");
        sockets.push(this);
    }
    open() {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
    }
    close() {
        this.closed = true;
        this.readyState = 3;
        if (this.rejectClose) throw new Error("close unavailable");
        this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "normal" }));
    }
    message(data: string | ArrayBuffer | Blob | number) {
        this.dispatchEvent(new MessageEvent("message", { data }));
    }
}
const latestSocket = () => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("expected an active socket");
    return socket;
};
const connect = (endpoint: string) => {
    let state = INITIAL_PRESENCE;
    const states: PresenceState[] = [];
    const fiber = Effect.runFork(
        presenceStream(endpoint).pipe(
            Stream.runForEach((next) =>
                Effect.sync(() => {
                    state = next;
                    states.push(next);
                }),
            ),
        ),
        { scheduler: new Scheduler.MixedScheduler("sync") },
    );
    fibers.push(fiber);
    return { fiber, states, current: () => state };
};
beforeEach(() => {
    vi.useFakeTimers();
    LocalSocket.rejectConstruction = false;
    vi.stubGlobal("WebSocket", LocalSocket);
});
afterEach(async () => {
    for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber));
    sockets.splice(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("retains the last track through capped reconnects and resets backoff after valid data", async () => {
    const feed = connect("ws://shared/presence");
    await vi.advanceTimersByTimeAsync(0);
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.current()).toEqual({ snapshot, settled: true, failed: false });
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const count = sockets.length;
        latestSocket().open();
        latestSocket().dispatchEvent(new Event("error"));
        await vi.advanceTimersByTimeAsync(0);
        expect(feed.current()).toEqual({ snapshot, settled: true, failed: true });
        expect(latestSocket().closed).toBe(true);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(sockets).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(count + 1);
    }
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await vi.advanceTimersByTimeAsync(0);
    latestSocket().message("not JSON");
    await vi.advanceTimersByTimeAsync(0);
    const count = sockets.length;
    expect(feed.current()).toEqual({ snapshot, settled: true, failed: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(count + 1);
    await Effect.runPromise(Fiber.interrupt(feed.fiber));
    expect(latestSocket().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(count + 1);
});

it.each([
    "not JSON",
    JSON.stringify({ status: "unexpected" }),
    new TextEncoder().encode(JSON.stringify(snapshot)).buffer,
    new Blob([JSON.stringify(snapshot)]),
    42,
])(
    "ends and retries the native connection after malformed or unsupported frame %s",
    async (frame) => {
        const feed = connect("ws://invalid/presence");
        await vi.advanceTimersByTimeAsync(0);
        latestSocket().open();
        latestSocket().message(frame);
        await vi.advanceTimersByTimeAsync(0);
        expect(feed.current()).toEqual({ snapshot: null, settled: true, failed: true });
        expect(latestSocket().closed).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sockets).toHaveLength(2);
    },
);

it("recovers from constructor failure, preserves adjacent valid data, and rejects late frames", async () => {
    LocalSocket.rejectConstruction = true;
    const feed = connect("ws://recovery/presence");
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.current()).toEqual({ snapshot: null, settled: true, failed: true });
    LocalSocket.rejectConstruction = false;
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    latestSocket().message("invalid");
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.current()).toEqual({ snapshot, settled: true, failed: true });
    const count = feed.states.length;
    const old = latestSocket();
    await Effect.runPromise(Fiber.interrupt(feed.fiber));
    old.open();
    old.message(JSON.stringify({ ...snapshot, status: "dnd" }));
    old.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(feed.states).toHaveLength(count);
});

it.each([false, true])(
    "keeps quiet connections open without a handshake or idle deadline (opened=%s)",
    async (opened) => {
        const feed = connect("ws://quiet/presence");
        await vi.advanceTimersByTimeAsync(0);
        if (opened) latestSocket().open();
        await vi.advanceTimersByTimeAsync(300000);
        expect(sockets).toHaveLength(1);
        expect(feed.current()).toEqual(INITIAL_PRESENCE);
        latestSocket().open();
        latestSocket().message(JSON.stringify(snapshot));
        await vi.advanceTimersByTimeAsync(300000);
        expect(feed.current()).toEqual({ snapshot, settled: true, failed: false });
        expect(sockets).toHaveLength(1);
        await Effect.runPromise(Fiber.interrupt(feed.fiber));
        expect(latestSocket().closed).toBe(true);
    },
);

it("isolates feed lifetimes and bounds delivery of a synchronous playback burst", async () => {
    const first = connect("ws://first/presence");
    const second = connect("ws://second/presence");
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets.find((candidate) => candidate.url === "ws://first/presence");
    if (socket === undefined) throw new Error("missing first connection");
    socket.open();
    for (let index = 0; index < 1000; index++)
        socket.message(
            JSON.stringify({ ...snapshot, song: { ...snapshot.song, title: `Track ${index}` } }),
        );
    await vi.advanceTimersByTimeAsync(0);
    expect(first.current().snapshot?.song?.title).toBe("Track 999");
    expect(first.states.length).toBeLessThanOrEqual(2);
    expect(second.current()).toEqual(INITIAL_PRESENCE);
    await Effect.runPromise(Fiber.interrupt(first.fiber));
    expect(socket.closed).toBe(true);
    expect(sockets.find((candidate) => candidate.url === "ws://second/presence")?.closed).toBe(
        false,
    );
});
