/**
 * The Discord activity boundary: the untrusted Gateway payload's schema and
 * the pure normalization that turns a Discord activity into a
 * {@link PresenceSong}.
 *
 * Nothing here trusts a field. Every URL that reaches the browser is re-parsed
 * and host-checked, an activity is only a song when it is genuinely a YouTube
 * Music "listening" activity, and an unexpected shape decodes to a failure
 * instead of a half-filled song.
 */
import * as Schema from "effect/Schema";
import {
    ARTWORK_URL_HOSTS,
    DISCORD_LISTENING_ACTIVITY_TYPE,
    SONG_URL_HOSTS,
    YOUTUBE_MUSIC_ACTIVITY_NAME,
} from "./config.ts";
import type { PresencePlayback, PresenceSong, PresenceStatus } from "./schema.ts";

/**
 * Discord ships rich-presence fields inconsistently: a client may omit a key
 * entirely or send it as `null` for the same missing value.
 */
const Nullable = Schema.optional(Schema.NullOr(Schema.String));

const DiscordActivityAssets = Schema.Struct({
    large_image: Nullable,
    large_text: Nullable,
    small_image: Nullable,
    small_text: Nullable,
});

/**
 * One entry of a presence's `activities` array. Every rich field stays
 * optional/nullable — including `details_url`, which dfx's vendored activity
 * type omits, so the original Gateway object is decoded with this schema
 * instead of being cast.
 */
export const DiscordActivity = Schema.Struct({
    name: Nullable,
    type: Schema.optional(Schema.NullOr(Schema.Finite)),
    details: Nullable,
    details_url: Nullable,
    state: Nullable,
    assets: Schema.optional(Schema.NullOr(DiscordActivityAssets)),
});

export type DiscordActivity = typeof DiscordActivity.Type;

/**
 * A Discord presence as the Gateway sends it. Unlike the rich fields, the two
 * things the snapshot is built from are required: a recognized status and an
 * activities array. A payload missing either is not a presence this build can
 * merge, and decoding it must fail rather than silently produce "offline with
 * no music".
 */
export const DiscordPresence = Schema.Struct({
    status: Schema.Literals(["online", "idle", "dnd", "offline"]),
    activities: Schema.Array(DiscordActivity),
});

export type DiscordPresence = typeof DiscordPresence.Type;

/** Decode an untrusted Gateway presence object, preserving `details_url`. */
export const decodeDiscordPresence = Schema.decodeUnknownEffect(DiscordPresence);

/** Discord's status, narrowed to what the portfolio can render. */
export function presenceStatus(presence: DiscordPresence): PresenceStatus {
    return presence.status;
}

/** A song Discord is reporting, plus how it is currently being played. */
export interface SongCandidate {
    readonly song: PresenceSong;
    readonly playback: Extract<PresencePlayback, "playing" | "paused">;
}

/**
 * The first genuine YouTube Music song across *all* activities — Discord
 * orders activities by recency of update, not by kind, so a custom status or a
 * game can sit at index 0 while music plays behind it.
 */
export function findSongCandidate(presence: DiscordPresence): SongCandidate | null {
    for (const activity of presence.activities) {
        const candidate = songFromActivity(activity);
        if (candidate !== null) return candidate;
    }
    return null;
}

function songFromActivity(activity: DiscordActivity): SongCandidate | null {
    if (activity.name !== YOUTUBE_MUSIC_ACTIVITY_NAME) return null;
    if (activity.type !== DISCORD_LISTENING_ACTIVITY_TYPE) return null;

    const title = activity.details?.trim() ?? "";
    const artist = activity.state?.trim() ?? "";
    if (title === "" || artist === "") return null;

    const url = safeUrl(activity.details_url, SONG_URL_HOSTS);
    if (url === null) return null;

    return {
        song: { title, artist, url, artworkUrl: artworkUrl(activity.assets?.large_image) },
        playback: isPaused(activity) ? "paused" : "playing",
    };
}

/**
 * A paused song is still the current song. Discord marks it on the small
 * asset: the rich-presence client sets `small_text` to "Paused" and swaps the
 * icon, so the text is authoritative and the icon name is the fallback.
 */
function isPaused(activity: DiscordActivity): boolean {
    const label = activity.assets?.small_text?.trim().toLowerCase();
    if (label === "paused") return true;
    if (label === "playing") return false;
    return (activity.assets?.small_image ?? "").toLowerCase().includes("pause");
}

/**
 * Resolve Discord's artwork reference to a URL a browser may load.
 *
 * Preserve Discord's proxy path, including optional encoded query segments
 * before `/https/`. Reconstructing the source URL loses those segments.
 */
export function artworkUrl(reference: string | null | undefined): string | null {
    if (reference === null || reference === undefined) return null;
    if (!reference.startsWith("mp:")) return safeUrl(reference, ARTWORK_URL_HOSTS);

    if (!reference.startsWith("mp:external/")) return null;
    return safeUrl(`https://media.discordapp.net/${reference.slice(3)}`, ARTWORK_URL_HOSTS);
}

/** Parse, require HTTPS, and require a known host. Percent-encoding is kept. */
function safeUrl(value: string | null | undefined, hosts: readonly string[]): string | null {
    if (value === null || value === undefined) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    if (!hosts.includes(parsed.hostname)) return null;
    return parsed.toString();
}
