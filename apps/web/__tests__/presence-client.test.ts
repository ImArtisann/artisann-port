import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import { presenceAtom, usePresence, type PresenceState } from "../src/lib/presence-client.ts";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";

const registries: AtomRegistry.AtomRegistry[] = [];
const sockets: LocalSocket[] = [];
const initial = { snapshot: null, settled: false, failed: false };
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
const flush = () => vi.advanceTimersByTimeAsync(0);
const latestSocket = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("expected an active socket");
    return socket;
};
const makeRegistry = () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 0, timeoutResolution: 1 });
    registries.push(registry);
    return registry;
};
beforeEach(() => {
    vi.useFakeTimers();
    LocalSocket.rejectConstruction = false;
    vi.stubGlobal("WebSocket", LocalSocket);
});
afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    sockets.splice(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("returns the initial state during SSR without constructing a socket", () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://ssr/presence");
    expect(Atom.getServerValue(atom, registry)).toEqual(initial);
    function Island() {
        return createElement("span", null, JSON.stringify(usePresence("ws://ssr/presence")));
    }
    const html = renderToString(
        createElement(RegistryContext.Provider, { value: registry }, createElement(Island)),
    );
    expect(html).toContain("settled&quot;:false");
    expect(sockets).toHaveLength(0);
});

it("shares one connection, retains snapshots, caps backoff, and resets only after valid data", async () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://shared/presence");
    const leaveFirst = registry.mount(atom);
    const leaveSecond = registry.mount(atom);
    expect(registry.get(atom)).toEqual(initial);
    await flush();
    expect(sockets).toHaveLength(1);
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: false });

    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const before = sockets.length;
        latestSocket().open();
        latestSocket().dispatchEvent(new Event("error"));
        await flush();
        expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: true });
        expect(latestSocket().closed).toBe(true);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(sockets).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(before + 1);
    }
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await flush();
    latestSocket().message("not JSON");
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: true });
    const beforeReset = sockets.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(beforeReset);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(beforeReset + 1);
    leaveFirst();
    await flush();
    expect(latestSocket().closed).toBe(false);
    leaveSecond();
    await flush();
    expect(latestSocket().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(beforeReset + 1);
});

it.each([
    "not JSON",
    JSON.stringify({ status: "unexpected" }),
    new TextEncoder().encode(JSON.stringify(snapshot)).buffer,
    new Blob([JSON.stringify(snapshot)]),
    42,
])("ends and retries an attempt for malformed or unsupported frame %s", async (frame) => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://invalid/presence");
    registry.mount(atom);
    await flush();
    latestSocket().open();
    latestSocket().message(frame);
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot: null, settled: true, failed: true });
    expect(latestSocket().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
});

it("retries constructor failures and reports a subsequent remote close", async () => {
    LocalSocket.rejectConstruction = true;
    const registry = makeRegistry();
    const atom = presenceAtom("ws://constructor/presence");
    registry.mount(atom);
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot: null, settled: true, failed: true });
    LocalSocket.rejectConstruction = false;
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await flush();
    latestSocket().close();
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: true });
});

it("does not accept valid frames after an invalid frame ends the attempt", async () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://ended/presence");
    registry.mount(atom);
    await flush();
    latestSocket().open();
    latestSocket().message("invalid");
    latestSocket().message(JSON.stringify(snapshot));
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot: null, settled: true, failed: true });
});

it("retains a validated snapshot immediately followed by a malformed frame", async () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://adjacent/presence");
    registry.mount(atom);
    await flush();
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    latestSocket().message("invalid");
    await flush();
    expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: true });
});

it.each([false, true])(
    "preserves no deadline while waiting for open/initial snapshot (opened=%s)",
    async (opened) => {
        const registry = makeRegistry();
        const atom = presenceAtom("ws://quiet/presence");
        const leave = registry.mount(atom);
        await flush();
        if (opened) latestSocket().open();
        await vi.advanceTimersByTimeAsync(300000);
        expect(sockets).toHaveLength(1);
        expect(registry.get(atom)).toEqual(initial);
        leave();
        await flush();
        expect(latestSocket().closed).toBe(true);
        await vi.advanceTimersByTimeAsync(60000);
        expect(sockets).toHaveLength(1);
    },
);

it("remains quiet after a snapshot without imposing an idle-message timeout", async () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://idle/presence");
    registry.mount(atom);
    await flush();
    latestSocket().open();
    latestSocket().message(JSON.stringify(snapshot));
    await vi.advanceTimersByTimeAsync(300000);
    expect(sockets).toHaveLength(1);
    expect(registry.get(atom)).toEqual({ snapshot, settled: true, failed: false });
});

it.each([false, true])(
    "ignores late callbacks and remounts fresh after disposal (backoff=%s)",
    async (backoff) => {
        const registry = makeRegistry();
        const atom = presenceAtom("ws://disposal/presence");
        const states: PresenceState[] = [];
        const leave = registry.subscribe(atom, (state) => states.push(state), { immediate: true });
        await flush();
        const oldSocket = latestSocket();
        oldSocket.rejectClose = true;
        if (backoff) {
            oldSocket.dispatchEvent(new Event("error"));
            await flush();
        }
        leave();
        await flush();
        const delivered = states.length;
        oldSocket.open();
        oldSocket.message(JSON.stringify(snapshot));
        oldSocket.dispatchEvent(new Event("error"));
        await vi.advanceTimersByTimeAsync(60000);
        expect(states).toHaveLength(delivered);
        expect(sockets).toHaveLength(1);
        registry.mount(atom);
        await flush();
        expect(sockets).toHaveLength(2);
        expect(registry.get(atom)).toEqual(initial);
    },
);

it("isolates endpoints and registries and closes only the departing endpoint", async () => {
    const registry = makeRegistry();
    const otherRegistry = makeRegistry();
    const first = presenceAtom("ws://first/presence");
    const second = presenceAtom("ws://second/presence");
    const leave = registry.mount(first);
    registry.mount(second);
    otherRegistry.mount(first);
    await flush();
    expect(sockets.map((socket) => socket.url)).toEqual([
        "ws://first/presence",
        "ws://second/presence",
        "ws://first/presence",
    ]);
    sockets[0]?.open();
    sockets[0]?.message(JSON.stringify(snapshot));
    await flush();
    expect(registry.get(first).snapshot).toEqual(snapshot);
    expect(registry.get(second)).toEqual(initial);
    expect(otherRegistry.get(first)).toEqual(initial);
    leave();
    await flush();
    expect(sockets.map((socket) => socket.closed)).toEqual([true, false, false]);
});

it("coalesces a synchronous burst into bounded latest-state delivery", async () => {
    const registry = makeRegistry();
    const atom = presenceAtom("ws://burst/presence");
    const titles: Array<string | undefined> = [];
    registry.subscribe(atom, (state) => titles.push(state.snapshot?.song?.title), {
        immediate: true,
    });
    await flush();
    latestSocket().open();
    for (let i = 0; i < 1000; i++) {
        latestSocket().message(
            JSON.stringify({ ...snapshot, song: { ...snapshot.song, title: `Track ${i}` } }),
        );
    }
    await flush();
    expect(registry.get(atom).snapshot?.song?.title).toBe("Track 999");
    expect(titles.length).toBeLessThanOrEqual(3);
});
