/**
 * Browser-safe presence configuration: constants and pure endpoint helpers. This module is
 * bundled into client code, so it never reads the environment and never
 * touches a credential.
 */

export const PORTFOLIO_API_ORIGIN = "https://presence.artisann.dev";
export const PUBLIC_RPC_PATH = "/rpc";
export const WRITER_RPC_PATH = "/rpc/writer";
export const NOTES_RPC_PATH = "/rpc/notes";
export const PRESENCE_WEBSOCKET_PATH = "/presence";

/**
 * Accept the base origin used by typed clients. Production origins must use
 * HTTPS; local verification may use HTTP only for an explicitly-port-qualified
 * loopback origin. The value itself must already be trimmed and root-pathed.
 */
export function isPortfolioApiOrigin(value: string): boolean {
    if (value.length === 0 || value !== value.trim()) return false;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return (
        parsed.pathname === "/" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.hostname.length > 0 &&
        (parsed.protocol === "https:" ||
            (parsed.protocol === "http:" &&
                (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
                // URL normalizes the default :80 away, so inspect the
                // authority to require that local HTTP always names a port.
                /^(?:localhost|127\.0\.0\.1):[0-9]+$/iu.test(
                    value.slice(value.indexOf("//") + 2).split("/")[0] ?? "",
                )))
    );
}

export interface PortfolioEndpoints {
    rpcUrl: string;
    writerRpcUrl: string;
    notesRpcUrl: string;
    presenceUrl: string;
}

/** Call only after validating the configured HTTP(S) base origin. */
export function portfolioEndpoints(baseUrl: string): PortfolioEndpoints {
    const origin = new URL(baseUrl);
    const presence = new URL(PRESENCE_WEBSOCKET_PATH, origin);
    presence.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return {
        rpcUrl: new URL(PUBLIC_RPC_PATH, origin).href,
        writerRpcUrl: new URL(WRITER_RPC_PATH, origin).href,
        notesRpcUrl: new URL(NOTES_RPC_PATH, origin).href,
        presenceUrl: presence.href,
    };
}

export const GITHUB_CRON = "*/15 * * * *";

/** The published site-content copy, written by the authoritative content writer. */
export const CONTENT_KEY = "site-content";

/** Custom domain bound to the presence Worker. */
export const PRESENCE_HOST = "presence.artisann.dev";

/**
 * Production KV namespace title. Other stages use separate namespaces so
 * test deployments cannot overwrite or delete the production last song.
 */
export const PRESENCE_KV_TITLE = "artisann-portfolio-presence";

/** The single key the snapshot lives under, written without any TTL. */
export const PRESENCE_SNAPSHOT_KEY = "snapshot";

/**
 * A snapshot older than this is reported as stale. The bot refreshes on every
 * confirmed Gateway presence change and periodic target confirmation, so 150s
 * tolerates a brief gap before the reader stops presenting the status as live.
 */
export const PRESENCE_STALE_AFTER_MS = 150_000;

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
