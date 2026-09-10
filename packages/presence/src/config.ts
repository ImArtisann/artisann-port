/**
 * Browser-safe presence configuration: shared constants only. This module is
 * bundled into client code, so it never reads the environment and never
 * touches a credential.
 */

/** Public read endpoint served by the presence Worker. */
export const PRESENCE_URL = "https://presence.artisann.dev/";

export const GITHUB_CALENDAR_URL = `${PRESENCE_URL}github`;
export const GITHUB_CRON = "*/15 * * * *";

/** Custom domain bound to the presence Worker. */
export const PRESENCE_HOST = "presence.artisann.dev";

/** Cron expression that drives the only regular writer of the snapshot. */
export const PRESENCE_CRON = "* * * * *";

/**
 * Production KV namespace title. Other stages use separate namespaces so
 * test deployments cannot overwrite or delete the production last song.
 */
export const PRESENCE_KV_TITLE = "artisann-portfolio-presence";

/** The single key the snapshot lives under, written without any TTL. */
export const PRESENCE_SNAPSHOT_KEY = "snapshot";

/** Discord user id whose presence is published. */
export const LANYARD_USER_ID = "176215532377210880";

/** Lanyard REST endpoint for {@link LANYARD_USER_ID}. */
export const LANYARD_URL = `https://api.lanyard.rest/v1/users/${LANYARD_USER_ID}`;

/**
 * A snapshot older than this is reported as stale. The cron writes every 60s,
 * so 150s tolerates two missed passes before the reader stops presenting the
 * status as live.
 */
export const PRESENCE_STALE_AFTER_MS = 150_000;

/**
 * Edge cache window for the public read. Short enough that a new song appears
 * within one client poll, long enough that a burst of visitors collapses into
 * a handful of Worker invocations.
 */
export const PRESENCE_CACHE_CONTROL = "public, max-age=15";

/** Activity `type` Discord uses for "Listening to". */
export const DISCORD_LISTENING_ACTIVITY_TYPE = 2;

/** Activity `name` published by the YouTube Music rich-presence client. */
export const YOUTUBE_MUSIC_ACTIVITY_NAME = "YouTube Music";

/**
 * Hosts a song link may point at. A link is rendered in the portfolio, so an
 * unexpected host is rejected rather than proxied or trusted.
 */
export const SONG_URL_HOSTS: readonly string[] = [
    "music.youtube.com",
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
];

/**
 * Hosts an artwork URL may point at: the Google/YouTube image CDNs that back
 * YouTube Music thumbnails, plus Discord's own CDN and media proxy.
 */
export const ARTWORK_URL_HOSTS: readonly string[] = [
    "yt3.googleusercontent.com",
    "yt3.ggpht.com",
    "lh3.googleusercontent.com",
    "i.ytimg.com",
    "i9.ytimg.com",
    "cdn.discordapp.com",
    "media.discordapp.net",
];
