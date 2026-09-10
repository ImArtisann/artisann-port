/**
 * Browser-safe asset configuration: shared constants and pure helpers only.
 * This module is bundled into client code, so it never reads the environment
 * and never touches a credential.
 */

/** One image collected from `images/`, as stored in the generated manifest. */
export interface AssetEntry {
    /** Source path relative to `images/`, e.g. `brand/logo.png`. */
    readonly path: string;
    /** Content-addressed object key, e.g. `brand/logo.a1b2c3d4.png`. */
    readonly key: string;
    readonly contentType: string;
    /** Intrinsic pixel width of the source image. */
    readonly width: number;
    /** Intrinsic pixel height of the source image. */
    readonly height: number;
    /** Size of the source file in bytes. */
    readonly bytes: number;
}

/** Directory inside this package that `bun run generate` walks, recursively. */
export const ASSET_SOURCE_DIRECTORY = "images";

/**
 * Extensions collected from `images/`, mapped to the `content-type` the object
 * is uploaded with. Anything else under `images/` fails generation instead of
 * being silently dropped from the manifest.
 */
export const ASSET_CONTENT_TYPES = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
} as const satisfies Readonly<Record<string, string>>;

/** Bucket name used when `ASSETS_BUCKET_NAME` is unset. */
export const DEFAULT_ASSETS_BUCKET_NAME = "artisann-portfolio-assets";

/**
 * Custom domain bound to the bucket, used when `ASSETS_HOST` is unset. Not a
 * secret and not environment-specific: the R2 custom domain is the same one for
 * every stage, so a build never needs a `.env` to know where assets live.
 */
export const DEFAULT_ASSETS_HOST = "assets.artisann.dev";

/**
 * Shared width ladder, keyed off intrinsic width — never display width — so the
 * same source image yields the same transformation set in every app.
 */
export const ASSET_WIDTHS = [320, 480, 640, 960, 1280, 1600, 1920, 2560] as const;

/**
 * Breakpoints for an intrinsic width: every ladder rung below it, plus the
 * intrinsic width itself, so a source image is never upscaled.
 */
export function assetWidthLadder(intrinsicWidth: number): number[] {
    return [...ASSET_WIDTHS.filter((width) => width < intrinsicWidth), intrinsicWidth];
}

/**
 * unpic `options`, CDN-keyed. `domain` pins the host that performs the
 * transformation, so the root-relative `src` from `assetSrc` resolves against
 * the asset origin instead of the app's own origin.
 */
export function assetImageOptions(host: string) {
    return { cloudflare: { domain: host } } as const;
}

/**
 * unpic `operations`, CDN-keyed. `format: "auto"` is one billable
 * transformation whether AVIF or WebP is served; explicit formats bill
 * separately. `fit: "scale-down"` never crops or upscales — unpic's cloudflare
 * provider defaults to `fit: "cover"`, which crops.
 *
 * Only used by apps that opt into Cloudflare image transformations; serving the
 * original object needs no operations at all.
 */
export const ASSET_IMAGE_OPERATIONS = {
    cloudflare: {
        format: "auto",
        fit: "scale-down",
        metadata: "none",
        quality: 82,
    },
} as const;

/** Object keys are content-addressed, so uploads are immutable forever. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
