/**
 * Build-time discovery of the images under `images/`. Runs under Bun only —
 * applications import the generated manifest and `src/urls.ts` instead.
 *
 * Every file becomes one asset whose manifest path is its path relative to
 * `images/` (so directories are the key prefixes) and whose object key embeds a
 * content hash, which makes uploads immutable and re-uploads idempotent.
 */
import { imageSize } from "image-size";
import { join, sep } from "node:path";
import { ASSET_CONTENT_TYPES, ASSET_SOURCE_DIRECTORY, type AssetEntry } from "./config.ts";

export interface CollectedAsset extends AssetEntry {
    /** Absolute path of the source file on disk. */
    readonly file: string;
}

/** Absolute path of the source directory this package collects from. */
export const sourceDirectory = Bun.fileURLToPath(
    new URL(`../${ASSET_SOURCE_DIRECTORY}/`, import.meta.url),
);

/**
 * `brand/logo.png` -> `brand/logo.a1b2c3d4.png`. The digest is over the file
 * bytes, so the key is stable across machines and changes only when the image
 * changes — which is what makes the objects immutably cacheable.
 */
export function hashedKey(path: string, data: Uint8Array): string {
    const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 16);
    const dot = path.lastIndexOf(".");
    return `${path.slice(0, dot)}.${digest}${path.slice(dot)}`;
}

/**
 * Every image under `images/`, sorted by path so the generated manifest and the
 * upload order are deterministic. The scaffold starts with an empty directory.
 */
export async function collectAssets(): Promise<CollectedAsset[]> {
    const paths: string[] = [];
    for await (const relativePath of new Bun.Glob("**/*").scan({
        cwd: sourceDirectory,
        onlyFiles: true,
        dot: false,
        followSymlinks: false,
    })) {
        paths.push(relativePath.split(sep).join("/"));
    }

    const collected: CollectedAsset[] = [];
    for (const path of paths.toSorted()) {
        const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
        if (!Object.hasOwn(ASSET_CONTENT_TYPES, extension)) {
            throw new Error(
                `Unsupported asset images/${path}: accepted extensions are ${Object.keys(
                    ASSET_CONTENT_TYPES,
                ).join(", ")}`,
            );
        }
        // SAFETY: the own-key check above narrows extension to a declared key.
        const contentType = ASSET_CONTENT_TYPES[extension as keyof typeof ASSET_CONTENT_TYPES];

        const file = join(sourceDirectory, path);
        const data = await Bun.file(file).bytes();
        const { width, height, orientation } = imageSize(data);
        if (!(width > 0 && height > 0)) {
            throw new Error(`Image images/${path} must have positive intrinsic dimensions.`);
        }
        // EXIF orientations 5-8 rotate a quarter turn, so the displayed image is
        // the stored one transposed.
        const transposed = orientation !== undefined && orientation >= 5 && orientation <= 8;

        collected.push({
            path,
            key: hashedKey(path, data),
            file,
            contentType,
            width: transposed ? height : width,
            height: transposed ? width : height,
            bytes: data.byteLength,
        });
    }

    return collected;
}
