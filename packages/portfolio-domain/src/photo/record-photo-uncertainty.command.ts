import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PhotoOperationConflict } from "./photo-operation.rejection.ts";
import { ManagedPhotoKey, PhotoGeneration, PhotoOperationId } from "./photo-operation.ts";

export class PhotoOperationUncertain extends Domain.Event("PhotoOperationUncertain", {
    operationId: PhotoOperationId,
    stage: Schema.Literals(["r2-upload", "r2-delete"]),
}) {}

export class RecordPhotoUncertainty extends Domain.Command("RecordPhotoUncertainty", {
    target: ManagedPhotoKey,
    input: {
        operationId: PhotoOperationId,
        generation: PhotoGeneration,
        stage: Schema.Literals(["r2-upload", "r2-delete"]),
    },
    events: [PhotoOperationUncertain],
    rejects: [PhotoOperationConflict],
}) {}
