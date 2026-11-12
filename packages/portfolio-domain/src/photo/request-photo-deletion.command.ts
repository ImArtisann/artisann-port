import * as Domain from "@alchemy.run/domain";
import { PhotoOperationConflict } from "./photo-operation.rejection.ts";
import {
    ManagedPhotoKey,
    PhotoDeletionRequest,
    PhotoOperationId,
    PhotoOperationsState,
} from "./photo-operation.ts";
import { PhotoOperationResumed } from "./photo-operation-resumed.event.ts";

export class PhotoDeletionRequested extends Domain.Event("PhotoDeletionRequested", {
    operationId: PhotoOperationId,
    request: PhotoDeletionRequest,
}) {}

export class RequestPhotoDeletion extends Domain.Command("RequestPhotoDeletion", {
    target: ManagedPhotoKey,
    input: { operationId: PhotoOperationId, request: PhotoDeletionRequest },
    events: [PhotoDeletionRequested, PhotoOperationResumed],
    rejects: [PhotoOperationConflict],
    reply: { state: PhotoOperationsState },
}) {}
