import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PhotoOperationConflict } from "./photo-operation.rejection.ts";
import {
    ManagedPhotoKey,
    PhotoGeneration,
    PhotoOperationId,
    PhotoOperationsState,
} from "./photo-operation.ts";

export class PhotoDeletionPrepared extends Domain.Event("PhotoDeletionPrepared", {
    operationId: PhotoOperationId,
    etag: Schema.NullOr(Schema.NonEmptyString),
}) {}

export class PreparePhotoDeletion extends Domain.Command("PreparePhotoDeletion", {
    target: ManagedPhotoKey,
    input: {
        operationId: PhotoOperationId,
        generation: PhotoGeneration,
        etag: Schema.NullOr(Schema.NonEmptyString),
    },
    events: [PhotoDeletionPrepared],
    rejects: [PhotoOperationConflict],
    reply: { state: PhotoOperationsState },
}) {}
