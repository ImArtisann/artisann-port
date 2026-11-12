import * as Domain from "@alchemy.run/domain";
import { PhotoOperationConflict } from "./photo-operation.rejection.ts";
import {
    ManagedPhotoKey,
    PhotoGeneration,
    PhotoOperationId,
    PhotoOperationOutcome,
} from "./photo-operation.ts";

export class PhotoOperationCompleted extends Domain.Event("PhotoOperationCompleted", {
    operationId: PhotoOperationId,
    outcome: PhotoOperationOutcome,
}) {}

export class CompletePhotoOperation extends Domain.Command("CompletePhotoOperation", {
    target: ManagedPhotoKey,
    input: {
        operationId: PhotoOperationId,
        generation: PhotoGeneration,
        outcome: PhotoOperationOutcome,
    },
    events: [PhotoOperationCompleted],
    rejects: [PhotoOperationConflict],
}) {}
