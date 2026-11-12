import {
    ManagedPhotoKey,
    PHOTO_WRITER_MAX_BYTES,
    PhotoOperationId,
    PhotoWriter,
    PhotoGeneration,
    PhotoOperationState,
    type PhotoUploadMode,
} from "@artisann-port/portfolio-domain/photo/photo-operation";
import { HttpsUrl } from "@artisann-port/portfolio-domain/content";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ApiUnavailable } from "./api-errors.ts";
import { PhotoDomainService, PhotoMutationError } from "./photo-domain-service.ts";
import {
    PhotoTag,
    photoUrl,
    readPhotos,
    type PhotoPage as PhotoPageValue,
    type PhotoTag as PhotoTagValue,
    type PhotosR2Binding,
} from "./photos.ts";

export interface PhotoStoredObject {
    readonly etag: string;
    readonly customMetadata?: Record<string, string>;
}

export interface PhotosR2MutationBinding extends PhotosR2Binding {
    readonly head: (key: string) => Promise<PhotoStoredObject | null>;
    readonly put: (
        key: string,
        bytes: Uint8Array,
        options: {
            readonly onlyIf?: { readonly etagDoesNotMatch: string };
            readonly customMetadata: Record<string, string>;
            readonly httpMetadata: { readonly contentType: string; readonly cacheControl: string };
        },
    ) => Promise<PhotoStoredObject | null>;
    readonly delete: (key: string) => Promise<void>;
}

export class PhotosBinding extends Context.Service<PhotosBinding, PhotosR2MutationBinding>()(
    "Photos.Binding",
) {}
export interface PhotosConfigValue {
    readonly assetsHost: string;
}
export class PhotosConfig extends Context.Service<PhotosConfig, PhotosConfigValue>()(
    "Photos.Config",
) {}

export interface PhotoUploadInput {
    readonly key: string;
    readonly tag: PhotoTagValue;
    readonly bytes: Uint8Array;
    readonly operationId: string;
    readonly mode: PhotoUploadMode;
    readonly actor: typeof PhotoWriter.Type;
}
export interface PhotoDeletionInput {
    readonly key: string;
    readonly operationId: string;
    readonly actor: typeof PhotoWriter.Type;
    readonly expectedEtag?: string;
    /** Only an object written by this upload operation may be deleted. */
    readonly expectedUploadOperationId?: string;
}
export const PhotoUploadReceipt = Schema.Struct({
    key: ManagedPhotoKey,
    url: HttpsUrl,
    tag: PhotoTag,
    operationId: PhotoOperationId,
    etag: Schema.NonEmptyString,
});
export type PhotoUploadReceipt = typeof PhotoUploadReceipt.Type;
export const PhotoDeletionReceipt = Schema.Struct({
    key: ManagedPhotoKey,
    operationId: PhotoOperationId,
});
export type PhotoDeletionReceipt = typeof PhotoDeletionReceipt.Type;
const reconciliationIdentity = { key: ManagedPhotoKey, operationId: PhotoOperationId };
const reconciliationEvidence = {
    ...reconciliationIdentity,
    expectedGeneration: PhotoGeneration,
    expectedEtag: Schema.NullOr(Schema.NonEmptyString),
};
export const PhotoReconciliationRequest = Schema.Union([
    Schema.Struct({ ...reconciliationIdentity, action: Schema.Literal("inspect") }),
    Schema.Struct({ ...reconciliationEvidence, action: Schema.Literal("recover-confirmed") }),
    Schema.Struct({
        ...reconciliationEvidence,
        action: Schema.Literals(["resume", "abort", "confirm-deleted"]),
        confirmation: Schema.Literal("original-writer-stopped"),
    }),
]);
export type PhotoReconciliationInput = typeof PhotoReconciliationRequest.Type & {
    readonly actor: typeof PhotoWriter.Type;
};
export const PhotoReconciliationResult = Schema.Struct({
    ...reconciliationIdentity,
    generation: PhotoGeneration,
    status: PhotoOperationState.fields.status,
    requestKind: Schema.Literals(["Upload", "Delete"]),
    evidence: Schema.Literals(["upload-confirmed", "absent", "present"]),
    storageEtag: Schema.NullOr(Schema.NonEmptyString),
    outcome: Schema.Literals(["not-applied", "unknown", "applied"]),
});
export type PhotoReconciliationResult = typeof PhotoReconciliationResult.Type;

export class PhotosService extends Context.Service<
    PhotosService,
    {
        readonly listPage: (
            tag: PhotoTagValue,
            cursor?: string,
        ) => Effect.Effect<PhotoPageValue, ApiUnavailable>;
        readonly reconcile: (
            input: PhotoReconciliationInput,
        ) => Effect.Effect<PhotoReconciliationResult, PhotoMutationError>;
        readonly upload: (
            input: PhotoUploadInput,
        ) => Effect.Effect<PhotoUploadReceipt, PhotoMutationError>;
        readonly delete: (
            input: PhotoDeletionInput,
        ) => Effect.Effect<PhotoDeletionReceipt, PhotoMutationError>;
    }
>()("Photos.Service") {}

const MAX_CURSOR_LENGTH = 4096;
const isPhotoTag = Schema.is(PhotoTag);
const isManagedKey = Schema.is(ManagedPhotoKey);
const isOperationId = Schema.is(PhotoOperationId);
const isWriter = Schema.is(PhotoWriter);

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

function isArrayBufferBacked(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
    return bytes.buffer instanceof ArrayBuffer;
}

const digestBytes = Effect.fn("Photos.digest")(function* (bytes: Uint8Array) {
    if (!isArrayBufferBacked(bytes)) {
        return yield* new PhotoMutationError({ reason: "InvalidImage", outcome: "not-applied" });
    }
    const digest = yield* Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", bytes),
        catch: () => new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" }),
    });
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    return hex;
});

function reconciliationResult(
    key: string,
    operationId: string,
    operation: typeof PhotoOperationState.Type,
    stored: PhotoStoredObject | null,
): PhotoReconciliationResult {
    const confirmedUpload =
        operation.request._tag === "Upload" &&
        stored?.customMetadata?.photoOperationId === operationId &&
        stored.customMetadata.photoDigest === operation.request.digest;
    return {
        key,
        operationId,
        generation: operation.generation,
        status: operation.status,
        requestKind: operation.request._tag,
        storageEtag: stored?.etag ?? null,
        evidence: confirmedUpload ? "upload-confirmed" : stored === null ? "absent" : "present",
        outcome:
            operation.status === "uploaded" || operation.status === "deleted"
                ? "applied"
                : operation.status === "collision" || operation.status === "changed"
                  ? "not-applied"
                  : "unknown",
    };
}

export const PhotosLive = Layer.effect(
    PhotosService,
    Effect.gen(function* () {
        const binding = yield* PhotosBinding;
        const config = yield* PhotosConfig;
        const domain = yield* PhotoDomainService;

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

        const upload = Effect.fn("PhotosService.upload")(function* (input: PhotoUploadInput) {
            const { key, tag, bytes, operationId, mode, actor } = input;
            if (
                !isManagedKey(key) ||
                !isPhotoTag(tag) ||
                !key.startsWith(`${tag}/`) ||
                !isOperationId(operationId) ||
                !isWriter(actor) ||
                (mode !== "create-only" && mode !== "replace")
            ) {
                return yield* new PhotoMutationError({
                    reason: "InvalidKey",
                    outcome: "not-applied",
                });
            }
            if (bytes.byteLength > PHOTO_WRITER_MAX_BYTES) {
                return yield* new PhotoMutationError({
                    reason: "TooLarge",
                    outcome: "not-applied",
                });
            }
            if (!isWebp(bytes)) {
                return yield* new PhotoMutationError({
                    reason: "InvalidImage",
                    outcome: "not-applied",
                });
            }
            const url = photoUrl(key, config.assetsHost);
            if (url === null)
                return yield* new PhotoMutationError({
                    reason: "Unavailable",
                    outcome: "not-applied",
                });
            const digest = yield* digestBytes(bytes);
            const { operation: state, execute } = yield* domain.begin(operationId, {
                _tag: "Upload",
                key,
                tag,
                actor,
                mode,
                digest,
                size: bytes.byteLength,
            });
            if (state.status === "collision") {
                return yield* new PhotoMutationError({
                    reason: "Collision",
                    outcome: "not-applied",
                });
            }
            if (state.status === "uploaded" && state.etag !== null) {
                return { key, url, tag, operationId, etag: state.etag };
            }
            if (state.status === "aborted") {
                return yield* new PhotoMutationError({
                    reason: "OperationConflict",
                    outcome: "unknown",
                });
            }
            const previous = yield* Effect.tryPromise({
                try: () => binding.head(key),
                catch: () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
            }).pipe(
                Effect.tapError(() =>
                    execute
                        ? domain.uncertain(key, operationId, state.generation, "r2-upload")
                        : Effect.void,
                ),
            );
            const owned =
                previous?.customMetadata?.photoOperationId === operationId &&
                previous.customMetadata.photoDigest === digest;
            if (owned && previous !== null) {
                yield* domain.complete(key, operationId, state.generation, {
                    _tag: "Uploaded",
                    etag: previous.etag,
                });
                return { key, url, tag, operationId, etag: previous.etag };
            }
            if (!execute)
                return yield* new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" });
            if (mode === "create-only" && previous !== null) {
                yield* domain.complete(key, operationId, state.generation, { _tag: "Collision" });
                return yield* new PhotoMutationError({
                    reason: "Collision",
                    outcome: "not-applied",
                });
            }
            yield* domain.authorize(key, operationId, state.generation);
            const written = yield* Effect.tryPromise({
                try: () =>
                    binding.put(key, bytes, {
                        onlyIf: mode === "create-only" ? { etagDoesNotMatch: "*" } : undefined,
                        customMetadata: { photoOperationId: operationId, photoDigest: digest },
                        httpMetadata: {
                            contentType: "image/webp",
                            cacheControl: "public, max-age=60, must-revalidate",
                        },
                    }),
                catch: () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
            }).pipe(
                Effect.tapError(() =>
                    domain.uncertain(key, operationId, state.generation, "r2-upload"),
                ),
            );
            if (written === null) {
                const raced = yield* Effect.tryPromise({
                    try: () => binding.head(key),
                    catch: () =>
                        new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                }).pipe(
                    Effect.tapError(() =>
                        domain.uncertain(key, operationId, state.generation, "r2-upload"),
                    ),
                );
                if (
                    raced?.customMetadata?.photoOperationId === operationId &&
                    raced.customMetadata.photoDigest === digest
                ) {
                    yield* domain.complete(key, operationId, state.generation, {
                        _tag: "Uploaded",
                        etag: raced.etag,
                    });
                    return { key, url, tag, operationId, etag: raced.etag };
                }
                if (mode !== "create-only") {
                    yield* domain.uncertain(key, operationId, state.generation, "r2-upload");
                    return yield* new PhotoMutationError({
                        reason: "Uncertain",
                        outcome: "unknown",
                    });
                }
                yield* domain.complete(key, operationId, state.generation, { _tag: "Collision" });
                return yield* new PhotoMutationError({
                    reason: "Collision",
                    outcome: "not-applied",
                });
            }
            yield* domain.complete(key, operationId, state.generation, {
                _tag: "Uploaded",
                etag: written.etag,
            });
            return { key, url, tag, operationId, etag: written.etag };
        });

        const deletePhoto = Effect.fn("PhotosService.delete")(function* (
            input: PhotoDeletionInput,
        ) {
            const { key, operationId, actor, expectedEtag, expectedUploadOperationId } = input;
            if (
                !isManagedKey(key) ||
                !isOperationId(operationId) ||
                !isWriter(actor) ||
                expectedEtag === "" ||
                (expectedUploadOperationId !== undefined &&
                    !isOperationId(expectedUploadOperationId))
            ) {
                return yield* new PhotoMutationError({
                    reason: "InvalidKey",
                    outcome: "not-applied",
                });
            }
            const { operation: state, execute } = yield* domain.begin(operationId, {
                _tag: "Delete",
                key,
                actor,
                expectedEtag: expectedEtag ?? null,
                expectedUploadOperationId: expectedUploadOperationId ?? null,
            });
            if (state.status === "deleted") return { key, operationId };
            if (state.status === "aborted") {
                return yield* new PhotoMutationError({
                    reason: "OperationConflict",
                    outcome: "unknown",
                });
            }
            if (state.status === "changed") {
                return yield* new PhotoMutationError({
                    reason: "OperationConflict",
                    outcome: "not-applied",
                });
            }
            const current = yield* Effect.tryPromise({
                try: () => binding.head(key),
                catch: () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
            }).pipe(
                Effect.tapError(() =>
                    execute
                        ? domain.uncertain(key, operationId, state.generation, "r2-delete")
                        : Effect.void,
                ),
            );
            const prepared = yield* domain
                .prepareDeletion(key, operationId, state.generation, current?.etag ?? null)
                .pipe(
                    Effect.tapError(() =>
                        execute
                            ? domain.uncertain(key, operationId, state.generation, "r2-delete")
                            : Effect.void,
                    ),
                );
            if (current === null) {
                yield* domain.complete(key, operationId, state.generation, { _tag: "Deleted" });
                return { key, operationId };
            }
            if (
                current.etag !== prepared.deletionEtag ||
                (expectedEtag !== undefined && current.etag !== expectedEtag) ||
                (expectedUploadOperationId !== undefined &&
                    current.customMetadata?.photoOperationId !== expectedUploadOperationId)
            ) {
                yield* domain.complete(key, operationId, state.generation, { _tag: "Changed" });
                return yield* new PhotoMutationError({
                    reason: "OperationConflict",
                    outcome: "not-applied",
                });
            }
            if (!execute)
                return yield* new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" });
            yield* domain.authorize(key, operationId, state.generation);
            // Native R2 cannot fence an external edit between this head and delete.
            yield* Effect.tryPromise({
                try: () => binding.delete(key),
                catch: () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
            }).pipe(
                Effect.tapError(() =>
                    domain.uncertain(key, operationId, state.generation, "r2-delete"),
                ),
            );
            yield* domain.complete(key, operationId, state.generation, { _tag: "Deleted" });
            return { key, operationId };
        });

        const reconcile = Effect.fn("PhotosService.reconcile")(
            function* (input: PhotoReconciliationInput) {
                if (input.actor !== "owner") {
                    return yield* new PhotoMutationError({
                        reason: "Unauthorized",
                        outcome: "not-applied",
                    });
                }
                const request = yield* Schema.decodeUnknownEffect(PhotoReconciliationRequest)(
                    input,
                ).pipe(
                    Effect.mapError(
                        () =>
                            new PhotoMutationError({
                                reason: "InvalidKey",
                                outcome: "not-applied",
                            }),
                    ),
                );
                const { key, operationId } = request;
                const operation = yield* domain.lookup(key, operationId);
                const stored = yield* Effect.tryPromise({
                    try: () => binding.head(key),
                    catch: () =>
                        new PhotoMutationError({ reason: "Unavailable", outcome: "unknown" }),
                });
                const inspection = reconciliationResult(key, operationId, operation, stored);
                if (request.action === "inspect") return inspection;
                if (
                    operation.generation !== request.expectedGeneration ||
                    inspection.storageEtag !== request.expectedEtag
                ) {
                    return yield* new PhotoMutationError({
                        reason: "OperationConflict",
                        outcome: "unknown",
                    });
                }
                if (request.action === "recover-confirmed") {
                    if (inspection.evidence !== "upload-confirmed" || stored === null) {
                        return yield* new PhotoMutationError({
                            reason: "OperationConflict",
                            outcome: "unknown",
                        });
                    }
                    yield* domain.complete(key, operationId, operation.generation, {
                        _tag: "Uploaded",
                        etag: stored.etag,
                    });
                } else if (request.action === "confirm-deleted") {
                    if (operation.request._tag !== "Delete" || stored !== null) {
                        return yield* new PhotoMutationError({
                            reason: "OperationConflict",
                            outcome: "unknown",
                        });
                    }
                    yield* domain.prepareDeletion(key, operationId, operation.generation, null);
                    yield* domain.complete(key, operationId, operation.generation, {
                        _tag: "Deleted",
                    });
                } else {
                    if (request.action === "abort" && inspection.evidence === "upload-confirmed") {
                        return yield* new PhotoMutationError({
                            reason: "OperationConflict",
                            outcome: "unknown",
                        });
                    }
                    yield* domain.reconcile(key, {
                        operationId,
                        expectedGeneration: request.expectedGeneration,
                        disposition: request.action,
                        observedEtag: inspection.storageEtag,
                        actor: input.actor,
                        confirmation: request.confirmation,
                    });
                }
                const resolved = yield* domain.lookup(key, operationId);
                return reconciliationResult(key, operationId, resolved, stored);
            },
            Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () =>
                    Effect.fail(
                        new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                    ),
            }),
        );
        return PhotosService.of({ listPage, upload, delete: deletePhoto, reconcile });
    }),
);
