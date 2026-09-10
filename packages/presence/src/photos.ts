/**
 * The photo gallery contract: managed R2 keys under `life/` and `cats/`, the
 * browser-safe schemas the website renders, and the narrow native-binding read
 * adapter used by the Worker's `photos.list` RPC.
 *
 * R2 is authoritative. There is no KV photo index and no sidecar manifest: a
 * page is one native `list` call, filtered to managed keys. URL normalization
 * follows the existing null-on-invalid pattern — untrusted input becomes
 * `null` for the caller to translate into a validation response, never an
 * exception and never a storage access.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpsUrl, IsoTimestamp } from "./content.ts";

/** The two public photo collections. */
export const PhotoTag = Schema.Literals(["life", "cats"]);

export type PhotoTag = typeof PhotoTag.Type;

/** Every tag literal, for pickers that must offer the full set. */
export const PHOTO_TAGS: readonly PhotoTag[] = ["life", "cats"];

/** Discord interaction ids are 17–20 digit snowflakes. */
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/u;

/** Managed photo key: one collection prefix plus the uploading interaction id. */
const MANAGED_PHOTO_KEY_PATTERN = /^(life|cats)\/[0-9]{17,20}\.webp$/u;

/**
 * The managed R2 key of one uploaded photo, or `null` when either part is
 * invalid. Command callers translate `null` into a validation response
 * without touching storage; a raw arbitrary R2 prefix is never accepted.
 */
export function photoKey(tag: PhotoTag, id: string): string | null {
    if (!SNOWFLAKE_PATTERN.test(id)) return null;
    return `${tag}/${id}.webp`;
}

function isHttpsHost(host: string): boolean {
    if (host === "" || host !== host.trim()) return false;
    let parsed: URL;
    try {
        parsed = new URL(`https://${host}`);
    } catch {
        return false;
    }
    return parsed.hostname === host && parsed.pathname === "/" && parsed.port === "";
}

/**
 * The public URL of one managed photo, or `null` when the key or the
 * configured host is invalid. URLs are always generated from the configured
 * assets host, never copied from untrusted object metadata.
 */
export function photoUrl(key: string, host: string): string | null {
    if (!MANAGED_PHOTO_KEY_PATTERN.test(key) || !isHttpsHost(host)) return null;
    return `https://${host}/${key}`;
}

export const Photo = Schema.Struct({
    key: Schema.String.check(Schema.isPattern(MANAGED_PHOTO_KEY_PATTERN)),
    url: HttpsUrl,
    /** When the object was uploaded, serialized as an ISO timestamp. */
    uploadedAt: IsoTimestamp,
});

export type Photo = typeof Photo.Type;

export const PhotoPage = Schema.Struct({
    tag: PhotoTag,
    photos: Schema.Array(Photo),
    /** The cursor to pass back for the next page, or `null` at the end. */
    nextCursor: Schema.NullOr(Schema.String),
});

export type PhotoPage = typeof PhotoPage.Type;

/** One native R2 object, as far as this adapter looks at it. */
export interface PhotosR2Object {
    readonly key: string;
    readonly uploaded: Date;
}

/**
 * One native `list` result. Discriminated like Cloudflare's own `R2Objects`:
 * a truncated page carries the continuation cursor. Declared structurally —
 * no `@cloudflare/workers-types` dependency — so any object with this shape
 * satisfies the binding.
 */
export type PhotosR2Page =
    | { readonly objects: readonly PhotosR2Object[]; readonly truncated: false }
    | {
          readonly objects: readonly PhotosR2Object[];
          readonly truncated: true;
          readonly cursor?: string | undefined;
      };

/** The subset of an R2 bucket binding the gallery read uses. */
export interface PhotosR2Binding {
    list(options: { prefix: string; cursor?: string; limit: number }): Promise<PhotosR2Page>;
}

const PhotosR2PageBoundary = Schema.Struct({
    objects: Schema.Array(
        Schema.Struct({
            key: Schema.String,
            uploaded: Schema.Date,
        }),
    ),
    truncated: Schema.Boolean,
    // Native R2 includes `cursor: undefined` on a completed listing.
    cursor: Schema.optional(Schema.String),
});

const decodePhotosR2Page = Schema.decodeUnknownEffect(PhotosR2PageBoundary, {
    onExcessProperty: "ignore",
});

/** R2 refused to answer, or answered in a shape the gallery cannot honor. */
export class PhotosError extends Schema.TaggedError<PhotosError>()("Photos.Error", {
    operation: Schema.String,
    cause: Schema.Defect(),
}) {}

/** How many native objects one `list` call asks for. */
export const PHOTOS_PAGE_LIMIT = 100;

/** A complete traversal or a failure, never a partially successful gallery. */
export const collectPhotos = Effect.fn("Photos.collect")(function* <E, R>(
    tag: PhotoTag,
    readPage: (cursor: string | undefined) => Effect.Effect<PhotoPage, E, R>,
) {
    const photos: Photo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
        const page = yield* readPage(cursor);
        if (page.tag !== tag || page.photos.some((photo) => !photo.key.startsWith(`${tag}/`))) {
            return yield* new PhotosError({
                operation: "photos.collect",
                cause: "Page contains another collection",
            });
        }
        photos.push(...page.photos);
        if (page.nextCursor === null) {
            return photos.sort(
                (a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.key.localeCompare(b.key),
            );
        }
        if (page.nextCursor === "" || cursors.has(page.nextCursor)) {
            return yield* new PhotosError({
                operation: "photos.collect",
                cause: "Invalid or repeated continuation cursor",
            });
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
});

/**
 * Read one gallery page: one native R2 `list` call with the exact collection
 * prefix, filtered to managed keys of that tag. The cursor is returned to the
 * caller whenever R2 says the page is truncated, including for a page whose
 * objects are all unmanaged. Callers own pagination and can decide when to
 * request the next page.
 */
export const readPhotos = Effect.fn("Photos.read")(function* (
    namespace: PhotosR2Binding,
    tag: PhotoTag,
    cursor: string | undefined,
    host: string,
) {
    // Reject an invalid configured host before serving any data.
    if (photoUrl(`${tag}/${"0".repeat(17)}.webp`, host) === null) {
        return yield* new PhotosError({
            operation: "r2.list",
            cause: `Configured assets host is invalid: ${host}`,
        });
    }

    const listOptions: Parameters<PhotosR2Binding["list"]>[0] = {
        prefix: `${tag}/`,
        limit: PHOTOS_PAGE_LIMIT,
    };
    if (cursor !== undefined) listOptions.cursor = cursor;
    const page = yield* Effect.tryPromise({
        try: () => namespace.list(listOptions),
        catch: (cause) => new PhotosError({ operation: "r2.list", cause }),
    }).pipe(
        Effect.flatMap(decodePhotosR2Page),
        Effect.mapError((cause) => new PhotosError({ operation: "r2.list", cause })),
    );
    const photos: Photo[] = [];
    for (const object of page.objects) {
        if (!object.key.startsWith(`${tag}/`)) continue;
        if (!MANAGED_PHOTO_KEY_PATTERN.test(object.key)) continue;
        const url = photoUrl(object.key, host);
        if (url === null) {
            return yield* new PhotosError({
                operation: "r2.list",
                cause: `R2 object ${object.key} is not a usable managed photo`,
            });
        }
        photos.push({ key: object.key, url, uploadedAt: object.uploaded.toISOString() });
    }
    if (page.truncated && (page.cursor === undefined || page.cursor === "")) {
        return yield* new PhotosError({
            operation: "r2.list",
            cause: "R2 reported a truncated page without a continuation cursor",
        });
    }
    return {
        tag,
        photos,
        nextCursor: page.truncated ? (page.cursor ?? null) : null,
    } satisfies PhotoPage;
});
