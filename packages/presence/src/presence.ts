/**
 * The presence logic, independent of any transport.
 *
 * {@link mergePresence} and {@link withFreshness} are pure: the bot calls
 * them with a presence it decoded from the Discord Gateway and the snapshot
 * it loaded from storage, and writes the result itself. Every failure path in
 * the bot leaves the stored snapshot untouched, so a Gateway outage or a
 * Discord client going offline can never erase the last song.
 */
import { PRESENCE_STALE_AFTER_MS } from "./config.ts";
import { findSongCandidate, presenceStatus } from "./activity.ts";
import type { DiscordPresence } from "./activity.ts";
import type { PresenceSnapshot } from "./schema.ts";

/**
 * Merge a freshly observed presence with the snapshot already stored.
 *
 * A song Discord reports right now wins, paused included — a paused track is
 * the current track. With no valid YouTube Music activity the previously
 * stored song is retained and demoted to `last-played`, which is what keeps
 * the widget populated while the desktop client is closed. Only a store that
 * has genuinely never held a song produces `none`.
 */
export function mergePresence(
    previous: PresenceSnapshot | null,
    presence: DiscordPresence,
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
 * present a status the bot stopped confirming as if it were live.
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
