import { describe, expect, it } from "vite-plus/test";
import { ApiUnavailable } from "../src/api-errors.ts";
import { PRESENCE_SNAPSHOT_KEY, PRESENCE_STALE_AFTER_MS } from "../src/config.ts";
import type { PresenceKvBinding } from "../src/store.ts";
import { UNINITIALIZED_SNAPSHOT } from "../src/schema.ts";
import type { PresenceSnapshot } from "../src/schema.ts";
import {
    PresenceController,
    type PresenceSocket,
    type PresenceStorage,
} from "../src/presence-object.ts";

const now = Date.parse("2026-09-08T03:00:00.000Z");
const updatedAt = new Date(now).toISOString();

const snapshot = (changes: Partial<PresenceSnapshot> = {}): PresenceSnapshot => ({
    status: "online",
    song: {
        title: "A track",
        artist: "An artist",
        url: "https://music.example.test/track",
        artworkUrl: null,
    },
    playback: "playing",
    updatedAt,
    stale: false,
    ...changes,
});

const encode = (value: PresenceSnapshot): string => JSON.stringify(value);

class MemoryStorage implements PresenceStorage {
    readonly values = new Map<string, unknown>();
    readonly alarms: Array<number | Date> = [];
    failGet = false;
    failPut = false;
    beforeGet: ((key: string) => Promise<void>) | undefined;

    async get<T>(key: string): Promise<T | undefined> {
        if (this.failGet) throw new Error("storage read failed");
        if (this.beforeGet) await this.beforeGet(key);
        // SAFETY: this double stores only the values requested by the
        // controller's typed storage operations; the native storage contract
        // is generic and returns that same value type to each caller.
        return this.values.get(key) as T | undefined;
    }

    async put<T>(key: string, value: T): Promise<void> {
        if (this.failPut) throw new Error("storage write failed");
        this.values.set(key, value);
    }

    async setAlarm(value: number | Date): Promise<void> {
        this.alarms.push(value);
    }
}

class MemoryKv implements PresenceKvBinding {
    readonly values = new Map<string, string>();
    failGet = false;
    getCalls = 0;

    async get(key: string): Promise<string | null> {
        this.getCalls += 1;
        if (this.failGet) throw new Error("legacy read failed");
        return this.values.get(key) ?? null;
    }

    async put(key: string, value: string): Promise<void> {
        this.values.set(key, value);
    }
}

class Peer implements PresenceSocket {
    readonly messages: string[] = [];
    readonly closes: Array<{ code?: number; reason?: string }> = [];

    send(message: string): void {
        this.messages.push(message);
    }

    close(code?: number, reason?: string): void {
        this.closes.push({ code, reason });
    }
}

class BrokenPeer extends Peer {
    override send(_message: string): void {
        throw new Error("socket is gone");
    }
}

const controller = (
    storage: MemoryStorage,
    legacy: MemoryKv,
    peers: () => ReadonlyArray<PresenceSocket> = () => [],
    clock = now,
) => new PresenceController(storage, legacy, peers, () => clock);

describe("PresenceController legacy bootstrap", () => {
    it("migrates a valid legacy snapshot before serving it", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        const value = snapshot();
        legacy.values.set(PRESENCE_SNAPSHOT_KEY, encode(value));

        const result = await controller(storage, legacy).getSnapshot();

        expect(result).toEqual(value);
        expect(storage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(encode(value));
        expect(legacy.getCalls).toBe(1);
    });

    it("persists the uninitialized snapshot for missing or corrupt legacy data", async () => {
        const missingStorage = new MemoryStorage();
        const missingLegacy = new MemoryKv();
        const missing = await controller(missingStorage, missingLegacy).getSnapshot();
        expect(missing).toEqual(UNINITIALIZED_SNAPSHOT);
        expect(missingStorage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(
            encode(UNINITIALIZED_SNAPSHOT),
        );

        const corruptStorage = new MemoryStorage();
        const corruptLegacy = new MemoryKv();
        corruptLegacy.values.set(PRESENCE_SNAPSHOT_KEY, "{not-json");
        const corrupt = await controller(corruptStorage, corruptLegacy).getSnapshot();
        expect(corrupt).toEqual(UNINITIALIZED_SNAPSHOT);
        expect(corruptStorage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(
            encode(UNINITIALIZED_SNAPSHOT),
        );
    });

    it("does not write an initialization marker after a failed legacy read, then retries", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        legacy.failGet = true;
        const instance = controller(storage, legacy);

        await expect(instance.getSnapshot()).rejects.toBeInstanceOf(ApiUnavailable);
        expect(storage.values.has(PRESENCE_SNAPSHOT_KEY)).toBe(false);

        legacy.failGet = false;
        expect(await instance.getSnapshot()).toEqual(UNINITIALIZED_SNAPSHOT);
        expect(storage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(encode(UNINITIALIZED_SNAPSHOT));
    });

    it("treats a corrupt authoritative value as unavailable instead of falling back to KV", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, "{corrupt-authority");
        legacy.values.set(PRESENCE_SNAPSHOT_KEY, encode(snapshot({ status: "idle" })));
        const instance = controller(storage, legacy);

        await expect(instance.getSnapshot()).rejects.toBeInstanceOf(ApiUnavailable);
        expect(legacy.getCalls).toBe(0);
        expect(storage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe("{corrupt-authority");
    });
});

describe("PresenceController publication and peers", () => {
    it("does not fan out when authoritative storage cannot commit", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(snapshot()));
        const peer = new Peer();
        storage.failPut = true;
        const instance = controller(storage, legacy, () => [peer]);

        await expect(instance.publishSnapshot(snapshot({ status: "idle" }))).rejects.toBeInstanceOf(
            ApiUnavailable,
        );
        expect(peer.messages).toEqual([]);
        expect(storage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(encode(snapshot()));
    });

    it("isolates one broken socket while broadcasting to remaining peers", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(snapshot()));
        const broken = new BrokenPeer();
        const healthy = new Peer();
        const next = snapshot({ status: "dnd" });

        await controller(storage, legacy, () => [broken, healthy]).publishSnapshot(next);

        expect(healthy.messages).toEqual([encode(next)]);
        expect(storage.values.get(PRESENCE_SNAPSHOT_KEY)).toBe(encode(next));
    });

    it("discovers attached peers after controller reconstruction", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(snapshot()));
        const attached = new Peer();
        const rebuilt = controller(storage, legacy, () => [attached]);
        const next = snapshot({ playback: "paused", status: "idle" });

        await rebuilt.publishSnapshot(next);

        expect(attached.messages).toEqual([encode(next)]);
    });

    it("does not let a socket's initial value move backward across a publication", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        const initial = snapshot({ status: "idle" });
        const next = snapshot({ status: "online", playback: "paused" });
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(initial));

        let releaseRead!: () => void;
        let enteredRead!: () => void;
        const readEntered = new Promise<void>((resolve) => {
            enteredRead = resolve;
        });
        const readReleased = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        storage.beforeGet = async () => {
            enteredRead();
            await readReleased;
        };

        const peer = new Peer();
        const instance = controller(storage, legacy, () => [peer]);
        let accepted = false;
        const connecting = instance.connect(peer, () => {
            accepted = true;
        });
        await readEntered;
        const publishing = instance.publishSnapshot(next);
        releaseRead();

        await connecting;
        await publishing;

        expect(accepted).toBe(true);
        expect(peer.messages).toEqual([encode(initial), encode(next)]);
    });
});

describe("PresenceController liveness authority", () => {
    it("arms liveness for the first socket attached to a fresh legacy observation", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        legacy.values.set(PRESENCE_SNAPSHOT_KEY, encode(snapshot()));
        const peer = new Peer();
        await controller(storage, legacy).connect(peer, () => undefined);
        expect(storage.alarms).toEqual([now + PRESENCE_STALE_AFTER_MS + 1]);
        await controller(storage, legacy, () => [peer], now + PRESENCE_STALE_AFTER_MS + 1).alarm();
        expect(JSON.parse(peer.messages[1] ?? "null")).toMatchObject({
            status: null,
            playback: "last-played",
            stale: true,
        });
    });

    it("publishes a delayed observation as stale without renewing its persisted timestamp", async () => {
        const storage = new MemoryStorage();
        const peer = new Peer();
        const value = snapshot();
        const instance = controller(
            storage,
            new MemoryKv(),
            () => [peer],
            now + PRESENCE_STALE_AFTER_MS + 1,
        );
        const result = await instance.publishSnapshot(value);
        expect(result.updatedAt).toBe(updatedAt);
        expect(peer.messages).toEqual([
            encode({ ...value, status: null, playback: "last-played", stale: true }),
        ]);
        expect(JSON.parse(String(storage.values.get(PRESENCE_SNAPSHOT_KEY))).updatedAt).toBe(
            updatedAt,
        );
    });

    it("keeps the inclusive 150000ms boundary fresh and marks 150001ms stale", async () => {
        const value = snapshot();
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(value));

        expect(
            await controller(
                storage,
                legacy,
                () => [],
                now + PRESENCE_STALE_AFTER_MS,
            ).getSnapshot(),
        ).toEqual(value);
        expect(
            await controller(
                storage,
                legacy,
                () => [],
                now + PRESENCE_STALE_AFTER_MS + 1,
            ).getSnapshot(),
        ).toEqual({
            ...value,
            status: null,
            playback: "last-played",
            stale: true,
        });
    });

    it("broadcasts the stale projection at the alarm and rearms fresh values for their deadline", async () => {
        const value = snapshot();
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(value));
        const peer = new Peer();
        const instance = controller(
            storage,
            legacy,
            () => [peer],
            now + PRESENCE_STALE_AFTER_MS + 1,
        );

        await instance.alarm();

        expect(peer.messages).toEqual([
            encode({
                ...value,
                status: null,
                playback: "last-played",
                stale: true,
            }),
        ]);
        expect(storage.alarms).toEqual([]);

        const freshStorage = new MemoryStorage();
        freshStorage.values.set(PRESENCE_SNAPSHOT_KEY, encode(value));
        const fresh = controller(freshStorage, legacy, () => [], now);
        await fresh.alarm();
        expect(
            freshStorage.alarms.map((alarm) => (alarm instanceof Date ? alarm.getTime() : alarm)),
        ).toEqual([now + PRESENCE_STALE_AFTER_MS + 1]);
    });

    it("ignores an older retry, clamps a future observation, and accepts an equal timestamp", async () => {
        const storage = new MemoryStorage();
        const legacy = new MemoryKv();
        const current = snapshot({ status: "idle" });
        storage.values.set(PRESENCE_SNAPSHOT_KEY, encode(current));
        const peer = new Peer();
        const instance = controller(storage, legacy, () => [peer], now);

        const older = snapshot({ status: "dnd", updatedAt: new Date(now - 1).toISOString() });
        expect(await instance.publishSnapshot(older)).toEqual(current);
        expect(peer.messages).toEqual([]);

        const future = snapshot({
            status: "online",
            updatedAt: new Date(now + 60_000).toISOString(),
        });
        const clamped = await instance.publishSnapshot(future);
        expect(clamped.updatedAt).toBe(updatedAt);
        expect(peer.messages).toEqual([encode(clamped)]);

        const equal = snapshot({ status: "dnd", playback: "paused", updatedAt });
        expect(await instance.publishSnapshot(equal)).toEqual(equal);
        expect(peer.messages).toEqual([encode(clamped), encode(equal)]);
    });
});
