/**
 * The upload path behind the owner's iOS Shortcut. Bytes are read under the
 * size cap before anything else, transcoded to WebP by the Images binding,
 * written create-only through Portfolio's photo owner, then claimed in D1.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ReadableStream as WorkersReadableStream } from "@cloudflare/workers-types";
import { photoKey, type PhotoTag } from "@artisann-port/presence/photos";
import { PhotoOwnerClient } from "@artisann-port/presence/photo-owner-client";
import { MAX_PHOTO_EDGE_PX, MAX_UPLOAD_BYTES, type UploadResult } from "../contracts.ts";
import { HeartsService } from "./hearts-service.ts";
import { makePhotoId } from "./photo-id.ts";

export class UploadError extends Schema.TaggedError<UploadError>()("Upload.Error", {
    reason: Schema.Literals(["InvalidImage", "TooLarge", "Unavailable"]),
}) {}

export interface UploadImagesBinding {
    input(stream: WorkersReadableStream<Uint8Array>): {
        transform(options: { width: number; height: number; fit: "scale-down" }): {
            output(options: { format: "image/webp"; quality: number }): Promise<{
                response(): { arrayBuffer(): Promise<ArrayBuffer> };
            }>;
        };
    };
}
export class UploadImages extends Context.Service<UploadImages, UploadImagesBinding>()(
    "Upload.Images",
) {}

/** WebP encoder quality for stored photos; visually lossless at card sizes. */
const WEBP_QUALITY = 82;

/**
 * Create-only writes allowed per upload: the first id plus two fresh ones for
 * keys the bucket already holds.
 */
const STORE_ATTEMPTS = 3;

/** The first twelve bytes of any WebP file, big-endian `RIFF….WEBP`. */
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

/**
 * The bytes as the stream the Images binding accepts. The Workers and DOM
 * declarations of `ReadableStream` differ only in their lib types — workerd's
 * own stream is what the Images runtime reads, and Alchemy's Images client
 * bridges the same pair — so this is a declaration-level bridge, not a runtime
 * change.
 */
function imageInput(bytes: Uint8Array): WorkersReadableStream<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    // SAFETY: the value is workerd's ReadableStream, which satisfies the
    // Workers declaration; only the DOM declaration differs on its reader type.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    return stream as unknown as WorkersReadableStream<Uint8Array>;
}

/**
 * Read the whole body while refusing to buffer past `MAX_UPLOAD_BYTES`: the
 * cap is enforced on the bytes that arrive, never on a declared length.
 */
const readCappedBody = Effect.fn("Upload.readCappedBody")(function* (
    body: Uint8Array | ReadableStream<Uint8Array>,
) {
    if (body instanceof Uint8Array) {
        if (body.byteLength > MAX_UPLOAD_BYTES) {
            return yield* new UploadError({ reason: "TooLarge" });
        }
        return body;
    }

    const chunks = yield* Stream.fromReadableStream({
        evaluate: () => body,
        onError: () => new UploadError({ reason: "Unavailable" }),
    }).pipe(
        Stream.mapAccumEffect(
            () => 0,
            (size, chunk: Uint8Array) => {
                const next = size + chunk.byteLength;
                if (next > MAX_UPLOAD_BYTES) {
                    return Effect.fail(new UploadError({ reason: "TooLarge" }));
                }
                return Effect.succeed([next, [chunk]] as const);
            },
        ),
        Stream.runCollect,
        Effect.map((collected) => {
            let length = 0;
            for (const chunk of collected) length += chunk.byteLength;
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of collected) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return bytes;
        }),
    );

    return chunks;
});

export interface UploadOperations {
    readonly upload: (
        tag: PhotoTag,
        body: Uint8Array | ReadableStream<Uint8Array>,
    ) => Effect.Effect<UploadResult, UploadError>;
}

export class UploadService extends Context.Service<UploadService, UploadOperations>()(
    "Upload.Service",
) {}

/** Native R2 + Images + D1 upload. Acquisition captures bindings, no I/O. */
export const UploadLive = Layer.effect(
    UploadService,
    Effect.gen(function* () {
        const images = yield* UploadImages;
        const photos = yield* PhotoOwnerClient;
        const hearts = yield* HeartsService;

        const upload = Effect.fn("Upload.upload")(function* (
            tag: PhotoTag,
            body: Uint8Array | ReadableStream<Uint8Array>,
        ) {
            const received = yield* readCappedBody(body);

            const transformed = yield* Effect.tryPromise({
                try: () =>
                    images
                        .input(imageInput(received))
                        .transform({
                            width: MAX_PHOTO_EDGE_PX,
                            height: MAX_PHOTO_EDGE_PX,
                            fit: "scale-down",
                        })
                        // WebP output always discards EXIF (Cloudflare Images
                        // docs), so phone GPS tags never reach the public object.
                        .output({ format: "image/webp", quality: WEBP_QUALITY }),
                catch: () => new UploadError({ reason: "InvalidImage" }),
            });

            const encoded = yield* Effect.tryPromise({
                try: () => transformed.response().arrayBuffer(),
                catch: () => new UploadError({ reason: "Unavailable" }),
            });
            const stored = new Uint8Array(encoded);
            if (!isWebp(stored)) return yield* new UploadError({ reason: "InvalidImage" });

            const created = yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt += 1) {
                    const id = yield* makePhotoId;
                    const key = photoKey(tag, id);
                    if (key === null) return yield* new UploadError({ reason: "InvalidImage" });
                    // Keys can collide, so they cannot identify an upload: a shared ID would
                    // replay or conflict with the other upload instead of reporting Collision.
                    const attempt = yield* Effect.sync(() => crypto.randomUUID());
                    const written = yield* photos
                        .upload({
                            key,
                            tag,
                            bytes: stored,
                            operationId: `cats-upload:${key}:${attempt}`,
                        })
                        .pipe(
                            Effect.match({
                                onSuccess: (receipt) => ({ _tag: "Stored" as const, receipt }),
                                onFailure: (error) => ({ _tag: "Failed" as const, error }),
                            }),
                        );
                    if (written._tag === "Stored") return written.receipt;
                    if (written.error.reason !== "Collision") {
                        return yield* new UploadError({ reason: "Unavailable" });
                    }
                }
                return yield* new UploadError({ reason: "Unavailable" });
            });
            const { key, url } = created;

            const uploadedAt = DateTime.formatIso(yield* DateTime.now);
            const rollback = photos
                .delete({
                    key,
                    operationId: `cats-rollback:${key}`,
                    expectedEtag: created.etag,
                })
                .pipe(
                    Effect.tapError(() => Effect.logError("Upload rollback failed", key)),
                    Effect.match({ onFailure: () => undefined, onSuccess: () => undefined }),
                );

            yield* hearts.register(key, tag, uploadedAt).pipe(
                Effect.mapError(() => new UploadError({ reason: "Unavailable" })),
                Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
            );

            return { key, url, tag, likes: 0 };
        });

        return { upload };
    }),
);
