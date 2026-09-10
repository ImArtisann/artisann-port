import type { R2Bucket } from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ApiUnavailable, PhotoWriteError } from "./api-errors.ts";
import {
    PhotoTag,
    photoKey,
    readPhotos,
    type PhotoPage as PhotoPageValue,
    type PhotoTag as PhotoTagValue,
    type PhotosR2Binding,
} from "./photos.ts";

/** The native R2 operations this service needs, kept structural for list(). */
export type PhotosR2MutationBinding = PhotosR2Binding & Pick<R2Bucket, "put" | "delete">;

export class PhotosBinding extends Context.Service<PhotosBinding, PhotosR2MutationBinding>()(
    "Photos.Binding",
) {}

export interface PhotosConfigValue {
    readonly assetsHost: string;
}

export class PhotosConfig extends Context.Service<PhotosConfig, PhotosConfigValue>()(
    "Photos.Config",
) {}

export class PhotosService extends Context.Service<
    PhotosService,
    {
        readonly listPage: (
            tag: PhotoTagValue,
            cursor?: string,
        ) => Effect.Effect<PhotoPageValue, ApiUnavailable>;
        readonly upload: (
            tag: PhotoTagValue,
            interactionId: string,
            bytes: Uint8Array,
        ) => Effect.Effect<string, PhotoWriteError | ApiUnavailable>;
        readonly delete: (
            tag: PhotoTagValue,
            photoId: string,
        ) => Effect.Effect<void, PhotoWriteError | ApiUnavailable>;
    }
>()("Photos.Service") {}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;

function isWebp(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    );
}

const isPhotoTag = Schema.is(PhotoTag);

/** Native R2-backed photo authority. Acquisition only captures binding/config values. */
export const PhotosLive = Layer.effect(
    PhotosService,
    Effect.gen(function* () {
        const binding = yield* PhotosBinding;
        const config = yield* PhotosConfig;

        const listPage = Effect.fn("PhotosService.listPage")(function* (
            tag: PhotoTagValue,
            cursor?: string,
        ) {
            if (!isPhotoTag(tag) || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
                return yield* new ApiUnavailable({ operation: "photos.list" });
            }
            return yield* readPhotos(binding, tag, cursor, config.assetsHost).pipe(
                Effect.mapError(() => new ApiUnavailable({ operation: "photos.list" })),
            );
        });

        const upload = Effect.fn("PhotosService.upload")(function* (
            tag: PhotoTagValue,
            interactionId: string,
            bytes: Uint8Array,
        ) {
            const key = isPhotoTag(tag) ? photoKey(tag, interactionId) : null;
            if (key === null) {
                return yield* new PhotoWriteError({ reason: "InvalidKey" });
            }
            if (bytes.byteLength === 0 || !isWebp(bytes)) {
                return yield* new PhotoWriteError({ reason: "InvalidImage" });
            }
            if (bytes.byteLength > MAX_UPLOAD_BYTES) {
                return yield* new PhotoWriteError({ reason: "TooLarge" });
            }
            yield* Effect.tryPromise({
                try: () =>
                    binding.put(key, bytes, {
                        httpMetadata: {
                            contentType: "image/webp",
                            cacheControl: "public, max-age=60, must-revalidate",
                        },
                    }),
                catch: () => new ApiUnavailable({ operation: "photos.upload" }),
            });
            return key;
        });

        const deletePhoto = Effect.fn("PhotosService.delete")(function* (
            tag: PhotoTagValue,
            photoId: string,
        ) {
            const key = isPhotoTag(tag) ? photoKey(tag, photoId) : null;
            if (key === null) {
                return yield* new PhotoWriteError({ reason: "InvalidKey" });
            }
            yield* Effect.tryPromise({
                try: () => binding.delete(key),
                catch: () => new ApiUnavailable({ operation: "photos.delete" }),
            });
        });

        return PhotosService.of({ listPage, upload, delete: deletePhoto });
    }),
);
