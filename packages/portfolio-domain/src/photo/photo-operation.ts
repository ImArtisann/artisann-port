import * as Schema from "effect/Schema";

export const PhotoOperationId = Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/u),
);
export const ManagedPhotoKey = Schema.String.check(
    Schema.isPattern(/^(life|cats)\/[0-9]{17,20}\.webp$/u),
);
export const PhotoCollection = Schema.Literals(["life", "cats"]);
export const PhotoWriter = Schema.Literals(["cats", "discord", "owner"]);
export type PhotoWriter = typeof PhotoWriter.Type;
export const PhotoUploadMode = Schema.Literals(["create-only", "replace"]);
export type PhotoUploadMode = typeof PhotoUploadMode.Type;
export const PhotoDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const PHOTO_WRITER_MAX_BYTES = 32 * 1024 * 1024;
export const PhotoGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const PhotoUploadRequest = Schema.TaggedStruct("Upload", {
    key: ManagedPhotoKey,
    tag: PhotoCollection,
    actor: PhotoWriter,
    mode: PhotoUploadMode,
    digest: PhotoDigest,
    size: Schema.Int.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(PHOTO_WRITER_MAX_BYTES),
    ),
});
export const PhotoDeletionRequest = Schema.TaggedStruct("Delete", {
    key: ManagedPhotoKey,
    actor: PhotoWriter,
    expectedEtag: Schema.NullOr(Schema.NonEmptyString),
});
export const PhotoOperationRequest = Schema.Union([PhotoUploadRequest, PhotoDeletionRequest]);
export type PhotoOperationRequest = typeof PhotoOperationRequest.Type;

export const PhotoOperationState = Schema.Struct({
    request: PhotoOperationRequest,
    status: Schema.Literals([
        "pending",
        "uncertain",
        "uploaded",
        "deleted",
        "collision",
        "changed",
        "aborted",
    ]),
    etag: Schema.NullOr(Schema.NonEmptyString),
    deletionInspected: Schema.Boolean,
    deletionEtag: Schema.NullOr(Schema.NonEmptyString),
    generation: PhotoGeneration,
});
export type PhotoOperationState = typeof PhotoOperationState.Type;

export const PhotoOperationsState = Schema.Struct({
    active: Schema.NullOr(PhotoOperationId),
    operations: Schema.Record(Schema.String, PhotoOperationState),
});
export type PhotoOperationsState = typeof PhotoOperationsState.Type;

export const PhotoOperationOutcome = Schema.Union([
    Schema.TaggedStruct("Uploaded", { etag: Schema.NonEmptyString }),
    Schema.TaggedStruct("Deleted", {}),
    Schema.TaggedStruct("Collision", {}),
    Schema.TaggedStruct("Changed", {}),
]);
export type PhotoOperationOutcome = typeof PhotoOperationOutcome.Type;
