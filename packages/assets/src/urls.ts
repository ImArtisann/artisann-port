/**
 * Browser-safe asset lookups. Everything here reads the generated manifest and
 * pure arguments only — the asset host comes from each app's own public env, so
 * this module never reaches for configuration or credentials.
 */
import { assetWidthLadder, type AssetEntry } from "./config.ts";
import { ASSET_MANIFEST, type AssetPath } from "./manifest.gen.ts";

export interface AssetDimensions {
    readonly width: number;
    readonly height: number;
}

/** Ready to spread into an unpic `<Image>`. */
export interface AssetImageProps {
    readonly src: string;
    readonly width: number;
    readonly height: number;
}

/**
 * Widened view of the manifest. `AssetPath` is `never` while the manifest is
 * empty, and indexing the literal object with it would then yield `never`, so
 * lookups go through the string index and validate at runtime instead.
 */
const MANIFEST: Readonly<Record<string, AssetEntry | undefined>> = ASSET_MANIFEST;

function entry(path: AssetPath): AssetEntry {
    const found = MANIFEST[path];
    if (found === undefined) {
        throw new Error(
            `Unknown asset ${String(path)}: run \`bun run generate\` in packages/assets`,
        );
    }
    return found;
}

/** Content-addressed object key, e.g. `brand/logo.a1b2c3d4.png`. */
export function assetKey(path: AssetPath): string {
    return entry(path).key;
}

/** Root-relative `src`, e.g. `/brand/logo.a1b2c3d4.png`. */
export function assetSrc(path: AssetPath): string {
    return `/${entry(path).key.split("/").map(encodeURIComponent).join("/")}`;
}

export function assetDimensions(path: AssetPath): AssetDimensions {
    const { width, height } = entry(path);
    return { width, height };
}

export function assetImageProps(path: AssetPath): AssetImageProps {
    const { key, width, height } = entry(path);
    return { src: `/${key.split("/").map(encodeURIComponent).join("/")}`, width, height };
}

/** Transformation widths for this image, clamped to its intrinsic width. */
export function assetBreakpoints(path: AssetPath): number[] {
    return assetWidthLadder(entry(path).width);
}

/**
 * Absolute, untransformed URL — for `og:image`, `twitter:image` and other
 * crawler-facing tags. `origin` is explicit (`https://assets.example.com`)
 * because only the app knows its own public env.
 */
export function assetUrl(path: AssetPath, origin: string): string {
    return `${origin.replace(/\/+$/, "")}${assetSrc(path)}`;
}

/**
 * Normalize `PUBLIC_ASSETS_HOST` to a bare hostname. Accepts a hostname or a
 * full `http(s)://` origin and strips a trailing slash.
 */
export function assetHost(hostOrOrigin: string): string {
    return hostOrOrigin
        .trim()
        .replace(/^https?:\/\//iu, "")
        .replace(/\/+$/, "");
}

/**
 * Narrow an arbitrary string — a content frontmatter field, a CMS value — to a
 * manifest path. Returns `undefined` for anything the manifest does not have,
 * which is also how a call site stays typecheckable while the manifest is empty.
 */
export function resolveAssetPath(value: string): AssetPath | undefined {
    const path = value.startsWith("/") ? value.slice(1) : value;
    if (!Object.hasOwn(ASSET_MANIFEST, path)) return undefined;
    // SAFETY: the own-key check establishes path as a manifest key.
    return path as AssetPath;
}

/** Same lookup, but a missing asset is a bug rather than an omitted image. */
export function requireAssetPath(value: string): AssetPath {
    const path = resolveAssetPath(value);
    if (path === undefined) {
        throw new Error(`Unknown asset ${value}: add it under packages/assets/images/`);
    }
    return path;
}
