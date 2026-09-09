/**
 * The presence contract: one snapshot, shared by the Worker that writes it,
 * the Worker that serves it, and the browser islands that render it.
 *
 * The snapshot is homomorphic — encoded and decoded shapes are identical — so
 * it travels as plain JSON and is decoded with this schema on every read of an
 * untrusted or persisted value.
 */
import * as Schema from "effect/Schema";

const DiscordStatus = Schema.Literals(["online", "idle", "dnd", "offline"]);

const Playback = Schema.Literals(["playing", "paused", "last-played", "none"]);

/**
 * Discord presence status, or `null` when it is unknown — the snapshot has
 * never been written, or it is stale and reporting the last known status as
 * live would be a lie.
 */
export type PresenceStatus = typeof DiscordStatus.Type | null;

/**
 * `playing` and `paused` describe a song Discord is reporting right now.
 * `last-played` is the retained song from an earlier pass, kept when nothing
 * is playing. `none` means no song has ever been observed.
 */
export type PresencePlayback = typeof Playback.Type;

const HttpsUrl = Schema.NonEmptyString.check(
    Schema.makeFilter<string>((value) => (value.startsWith("https://") ? undefined : false), {
        identifier: "Presence.HttpsUrl",
    }),
);

/** A single YouTube Music track, normalized from a Discord activity. */
export const PresenceSong = Schema.Struct({
    /** Track title (`activity.details`). */
    title: Schema.NonEmptyString,
    /** Artist or channel (`activity.state`). */
    artist: Schema.NonEmptyString,
    /** Validated HTTPS link to the track (`activity.details_url`). */
    url: HttpsUrl,
    /** Validated HTTPS artwork URL, or `null` when none could be resolved. */
    artworkUrl: Schema.NullOr(HttpsUrl),
});

export type PresenceSong = typeof PresenceSong.Type;

/** Everything the portfolio needs to render the online and music widgets. */
export const PresenceSnapshot = Schema.Struct({
    status: Schema.NullOr(DiscordStatus),
    song: Schema.NullOr(PresenceSong),
    playback: Playback,
    /** ISO timestamp of the refresh that produced this snapshot. */
    updatedAt: Schema.NullOr(Schema.NonEmptyString),
    /** `true` when the snapshot is older than the freshness window. */
    stale: Schema.Boolean,
});

export type PresenceSnapshot = typeof PresenceSnapshot.Type;

/**
 * Effect decoder for a stored snapshot *document*: the JSON text as it lives
 * in KV. Parsing and validation are one step, so malformed text and a wrong
 * shape fail identically instead of throwing past the caller.
 */
export const decodePresenceDocument = Schema.decodeUnknownEffect(
    Schema.fromJsonString(PresenceSnapshot),
);

/**
 * What a reader sees before the first refresh has landed. Explicitly empty:
 * never a fabricated status, never a fabricated song.
 */
export const UNINITIALIZED_SNAPSHOT: PresenceSnapshot = {
    status: null,
    song: null,
    playback: "none",
    updatedAt: null,
    stale: true,
};
