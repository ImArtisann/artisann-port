/**
 * The Lanyard boundary: the untrusted payload's schema, one named effect that
 * fetches it, and the pure normalization that turns a Discord activity into a
 * {@link PresenceSong}.
 *
 * Nothing here trusts a field. Every URL that reaches the browser is re-parsed
 * and host-checked, an activity is only a song when it is genuinely a YouTube
 * Music "listening" activity, and an unexpected shape decodes to a failure
 * instead of a half-filled song.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import {
    ARTWORK_URL_HOSTS,
    DISCORD_LISTENING_ACTIVITY_TYPE,
    LANYARD_URL,
    SONG_URL_HOSTS,
    YOUTUBE_MUSIC_ACTIVITY_NAME,
} from "./config.ts";
import type { PresencePlayback, PresenceSong, PresenceStatus } from "./schema.ts";

/**
 * Lanyard passes Discord's payload through untouched, so every field is
 * optional and may arrive as `null`.
 */
const Nullable = Schema.optional(Schema.NullOr(Schema.String));

const LanyardAssets = Schema.Struct({
    large_image: Nullable,
    large_text: Nullable,
    small_image: Nullable,
    small_text: Nullable,
});

const LanyardActivity = Schema.Struct({
    name: Nullable,
    type: Schema.optional(Schema.NullOr(Schema.Number)),
    details: Nullable,
    details_url: Nullable,
    state: Nullable,
    assets: Schema.optional(Schema.NullOr(LanyardAssets)),
});

export interface LanyardActivity extends Schema.Schema.Type<typeof LanyardActivity> {}

const LanyardPresence = Schema.Struct({
    discord_status: Nullable,
    activities: Schema.optional(Schema.NullOr(Schema.Array(LanyardActivity))),
});

export interface LanyardPresence extends Schema.Schema.Type<typeof LanyardPresence> {}

/** The envelope: `success: false` carries no presence at all. */
export const LanyardResponse = Schema.Struct({
    success: Schema.Boolean,
    data: Schema.optional(Schema.NullOr(LanyardPresence)),
    error: Schema.optional(Schema.NullOr(Schema.Struct({ code: Nullable, message: Nullable }))),
});

export interface LanyardResponse extends Schema.Schema.Type<typeof LanyardResponse> {}

/**
 * Lanyard did not hand back a presence: transport failure, non-2xx status, an
 * unexpected body, or `success: false`. Always non-destructive — a refresh
 * that fails this way leaves the stored snapshot exactly as it was.
 */
export class LanyardError extends Schema.TaggedError<LanyardError>()("Presence.LanyardError", {
    operation: Schema.String,
    cause: Schema.Defect(),
}) {}

/** Fetch and decode the live presence for the configured Discord user. */
export const fetchLanyardPresence = Effect.fn("Presence.fetchLanyard")(function* () {
    const response = yield* HttpClient.get(LANYARD_URL, { acceptJson: true }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError((cause) => new LanyardError({ operation: "fetch", cause })),
    );
    const body = yield* HttpIncomingMessage.schemaBodyJson(LanyardResponse)(response).pipe(
        Effect.mapError((cause) => new LanyardError({ operation: "decode", cause })),
    );
    if (!body.success) {
        return yield* new LanyardError({
            operation: "rejected",
            cause: body.error?.message ?? "Lanyard reported success: false",
        });
    }
    const presence = body.data;
    if (presence === null || presence === undefined) {
        return yield* new LanyardError({
            operation: "rejected",
            cause: "Lanyard reported success without a presence",
        });
    }
    return presence;
});

/** A song Discord is reporting, plus how it is currently being played. */
export interface SongCandidate {
    readonly song: PresenceSong;
    readonly playback: Extract<PresencePlayback, "playing" | "paused">;
}

/**
 * Discord's status, or `null` for an unrecognized value — a status the
 * portfolio cannot render is better than a guess, and it never invalidates the
 * song that came with it.
 */
export function presenceStatus(presence: LanyardPresence): PresenceStatus {
    switch (presence.discord_status) {
        case "online":
        case "idle":
        case "dnd":
        case "offline":
            return presence.discord_status;
        default:
            return null;
    }
}

/**
 * The first genuine YouTube Music song across *all* activities — Discord
 * orders activities by recency of update, not by kind, so a custom status or a
 * game can sit at index 0 while music plays behind it.
 */
export function findSongCandidate(presence: LanyardPresence): SongCandidate | null {
    for (const activity of presence.activities ?? []) {
        const candidate = songFromActivity(activity);
        if (candidate !== null) return candidate;
    }
    return null;
}

function songFromActivity(activity: LanyardActivity): SongCandidate | null {
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
function isPaused(activity: LanyardActivity): boolean {
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
