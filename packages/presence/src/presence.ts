/**
 * The presence logic, independent of any transport.
 *
 * Two operations, with opposite responsibilities:
 *
 * - {@link refreshPresence} is the only writer. The cron calls it once a
 *   minute; it fetches Lanyard, merges the result with what is already stored,
 *   and writes. Every failure path leaves the stored snapshot untouched, so a
 *   Lanyard outage or a Discord client going offline can never erase the last
 *   song.
 * - {@link readPresence} never writes. It decodes the stored snapshot and
 *   applies the freshness window, so the request path is free of races and of
 *   KV's one-write-per-second-per-key limit no matter how many visitors arrive.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PRESENCE_STALE_AFTER_MS } from "./config.ts";
import { fetchLanyardPresence, findSongCandidate, presenceStatus } from "./lanyard.ts";
import type { LanyardPresence } from "./lanyard.ts";
import { UNINITIALIZED_SNAPSHOT, decodePresenceDocument } from "./schema.ts";
import type { PresenceSnapshot } from "./schema.ts";
import type { PresenceStore } from "./store.ts";

/**
 * Merge a fresh Lanyard presence with the snapshot already stored.
 *
 * A song Discord reports right now wins, paused included — a paused track is
 * the current track. With no valid YouTube Music activity the previously
 * stored song is retained and demoted to `last-played`, which is what keeps
 * the widget populated while the desktop client is closed. Only a store that
 * has genuinely never held a song produces `none`.
 */
export function mergePresence(
    previous: PresenceSnapshot | null,
    presence: LanyardPresence,
    observedAt: Date,
): PresenceSnapshot {
    const candidate = findSongCandidate(presence);
    const retained = previous?.song ?? null;
    return {
        status: presenceStatus(presence),
        song: candidate?.song ?? retained,
        playback: candidate?.playback ?? (retained === null ? "none" : "last-played"),
        updatedAt: observedAt.toISOString(),
        stale: false,
    };
}

/**
 * Apply the freshness window to a stored snapshot.
 *
 * A stale snapshot keeps its song — that is the whole point of storing it —
 * but loses its status and its live playback state. The reader can then never
 * present a status the cron stopped confirming as if it were live.
 */
export function withFreshness(snapshot: PresenceSnapshot, now: Date): PresenceSnapshot {
    const updatedAt = snapshot.updatedAt === null ? null : Date.parse(snapshot.updatedAt);
    const fresh =
        updatedAt !== null &&
        !Number.isNaN(updatedAt) &&
        now.getTime() - updatedAt <= PRESENCE_STALE_AFTER_MS;
    if (fresh) return { ...snapshot, stale: false };
    return {
        status: null,
        song: snapshot.song,
        playback: snapshot.song === null ? "none" : "last-played",
        updatedAt: snapshot.updatedAt,
        stale: true,
    };
}

/**
 * Decode the stored snapshot, or `null` when there is nothing usable there.
 *
 * A missing key is a cold start. A value that fails to decode is treated the
 * same way and logged: it is a document this build cannot honor, and the next
 * refresh is entitled to replace it. A *read failure* is not swallowed — it
 * propagates, because a writer that cannot see the stored song must not
 * overwrite it.
 */
export const loadPresence = Effect.fn("Presence.load")(function* (store: PresenceStore) {
    const document = yield* store.read;
    if (Option.isNone(document)) return null;
    return yield* decodePresenceDocument(document.value).pipe(
        Effect.tapError((error) =>
            Effect.logWarning("Presence: discarding undecodable stored snapshot", error),
        ),
        Effect.orElseSucceed(() => null),
    );
});

/**
 * The public read: the stored snapshot with freshness applied, or the explicit
 * uninitialized snapshot before the first refresh has landed.
 */
export const readPresence = Effect.fn("Presence.read")(function* (store: PresenceStore) {
    const stored = yield* loadPresence(store);
    if (stored === null) return UNINITIALIZED_SNAPSHOT;
    return withFreshness(stored, new Date());
});

/**
 * The only regular writer. Fetches Lanyard, merges with the stored snapshot,
 * writes the result, and returns what is now authoritative.
 *
 * Fails with `LanyardError` when Lanyard is unavailable or rejects, and with
 * `PresenceStoreError` when storage does — in both cases without having
 * written anything, so the retained song survives.
 */
export const refreshPresence = Effect.fn("Presence.refresh")(function* (store: PresenceStore) {
    const previous = yield* loadPresence(store);
    const presence = yield* fetchLanyardPresence().pipe(Effect.timeout("15 seconds"));
    const snapshot = mergePresence(previous, presence, new Date());
    yield* store.write(JSON.stringify(snapshot));
    return snapshot;
});
