/**
 * Build-time discovery of the images under `images/`. Runs under Bun only —
 * applications import the generated manifest and `src/urls.ts` instead.
 *
 * Every file becomes one asset whose manifest path is its path relative to
 * `images/` (so directories are the key prefixes) and whose object key embeds a
 * content hash, which makes uploads immutable and re-uploads idempotent.
 */
import { imageSize } from "image-size";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ASSET_CONTENT_TYPES, ASSET_SOURCE_DIRECTORY, type AssetEntry } from "./config.ts";

export class AssetError extends Schema.TaggedError<AssetError>()("AssetError", {
    message: Schema.String,
}) {}

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
 *
 * Bun.Glob stays the scan boundary so collection keeps `onlyFiles`, no dotfiles,
 * and no symlink follow — Effect `FileSystem.glob` does not offer that set.
 */
export const collectAssets = Effect.gen(function* () {
    const paths = yield* Path.Path;
    const relativePaths = yield* Stream.fromAsyncIterable(
        new Bun.Glob("**/*").scan({
            cwd: sourceDirectory,
            onlyFiles: true,
            dot: false,
            followSymlinks: false,
        }),
        (cause) =>
            new AssetError({
                message: cause instanceof Error ? cause.message : String(cause),
            }),
    ).pipe(
        Stream.map((relativePath) => relativePath.split(paths.sep).join("/")),
        Stream.runCollect,
    );

    return yield* Effect.forEach(relativePaths.toSorted(), (path) =>
        Effect.gen(function* () {
            const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
            if (!Object.hasOwn(ASSET_CONTENT_TYPES, extension)) {
                return yield* new AssetError({
                    message: `Unsupported asset images/${path}: accepted extensions are ${Object.keys(
                        ASSET_CONTENT_TYPES,
                    ).join(", ")}`,
                });
            }
            // SAFETY: the own-key check above narrows extension to a declared key.
            const contentType = ASSET_CONTENT_TYPES[extension as keyof typeof ASSET_CONTENT_TYPES];

            const file = paths.join(sourceDirectory, path);
            const data = yield* Effect.tryPromise({
                try: () => Bun.file(file).bytes(),
                catch: (cause) =>
                    new AssetError({
                        message: cause instanceof Error ? cause.message : String(cause),
                    }),
            });
            const { width, height, orientation } = yield* Effect.try({
                try: () => imageSize(data),
                catch: (cause) =>
                    new AssetError({
                        message: cause instanceof Error ? cause.message : String(cause),
                    }),
            });
            if (!(width > 0 && height > 0)) {
                return yield* new AssetError({
                    message: `Image images/${path} must have positive intrinsic dimensions.`,
                });
            }
            // EXIF orientations 5-8 rotate a quarter turn, so the displayed image is
            // the stored one transposed.
            const transposed = orientation !== undefined && orientation >= 5 && orientation <= 8;

            return {
                path,
                key: hashedKey(path, data),
                file,
                contentType,
                width: transposed ? height : width,
                height: transposed ? width : height,
                bytes: data.byteLength,
            } satisfies CollectedAsset;
        }),
    );
});
