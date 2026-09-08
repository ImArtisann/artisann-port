import { PRESENCE_URL } from "@artisann-port/presence/config";
import { PresenceSnapshot } from "@artisann-port/presence/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { useSyncExternalStore } from "react";

/** The worker refreshes its snapshot every minute; twice that cadence keeps the UI close enough. */
export const PRESENCE_POLL_INTERVAL_MS = 30_000;

export interface PresenceState {
    /** Last snapshot the endpoint returned, or `null` before the first successful read. */
    readonly snapshot: PresenceSnapshot | null;
    /** `false` until the first request settles, so the UI can say "connecting" instead of "offline". */
    readonly settled: boolean;
    /** `true` when the most recent request failed; a retained snapshot is no longer trustworthy. */
    readonly failed: boolean;
}

const INITIAL_STATE: PresenceState = { snapshot: null, settled: false, failed: false };

interface PresenceStore {
    readonly subscribe: (onStoreChange: () => void) => () => void;
    readonly getSnapshot: () => PresenceState;
    readonly getServerSnapshot: () => PresenceState;
}

const decodeBody = HttpClientResponse.schemaBodyJson(PresenceSnapshot);

const readSnapshot = (endpoint: string) =>
    HttpClient.get(endpoint, { headers: { accept: "application/json" } }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeBody),
        Effect.timeout("10 seconds"),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(FetchHttpClient.layer),
    );

const createStore = (endpoint: string): PresenceStore => {
    const request = readSnapshot(endpoint);
    const listeners = new Set<() => void>();

    let state = INITIAL_STATE;
    let inFlight: AbortController | null = null;
    let timer: number | null = null;

    const publish = (next: PresenceState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    const poll = async () => {
        const attempt = new AbortController();
        inFlight = attempt;

        const exit = await Effect.runPromiseExit(request, { signal: attempt.signal });

        // A newer attempt or an unsubscribe replaced this one: its result is no longer ours to publish.
        if (inFlight !== attempt) return;
        inFlight = null;

        publish(
            Exit.isSuccess(exit)
                ? { snapshot: exit.value, settled: true, failed: false }
                : { snapshot: state.snapshot, settled: true, failed: true },
        );

        if (listeners.size > 0) {
            timer = window.setTimeout(() => void poll(), PRESENCE_POLL_INTERVAL_MS);
        }
    };

    const subscribe = (onStoreChange: () => void) => {
        listeners.add(onStoreChange);
        if (listeners.size === 1 && timer === null && inFlight === null) void poll();

        return () => {
            listeners.delete(onStoreChange);
            if (listeners.size > 0) return;

            if (timer !== null) {
                window.clearTimeout(timer);
                timer = null;
            }
            if (inFlight !== null) {
                const aborted = inFlight;
                inFlight = null;
                aborted.abort();
            }
        };
    };

    return {
        subscribe,
        getSnapshot: () => state,
        getServerSnapshot: () => INITIAL_STATE,
    };
};

const stores = new Map<string, PresenceStore>();

const presenceStore = (endpoint: string): PresenceStore => {
    const existing = stores.get(endpoint);
    if (existing !== undefined) return existing;

    const created = createStore(endpoint);
    stores.set(endpoint, created);
    return created;
};

/**
 * Subscribes to the shared presence poll. Every island reading the same endpoint shares one
 * request loop, which starts on the first subscriber and aborts on the last unsubscribe.
 */
export const usePresence = (endpoint: string = PRESENCE_URL): PresenceState => {
    const store = presenceStore(endpoint);
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
};
