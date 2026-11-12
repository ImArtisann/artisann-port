import * as Domain from "@alchemy.run/domain";
import { InvalidPhotoOperation, PhotoOperationConflict } from "./photo-operation.rejection.ts";
import {
    ManagedPhotoKey,
    PhotoOperationId,
    PhotoOperationsState,
    PhotoUploadRequest,
} from "./photo-operation.ts";
import { PhotoOperationResumed } from "./photo-operation-resumed.event.ts";

export class PhotoUploadRequested extends Domain.Event("PhotoUploadRequested", {
    operationId: PhotoOperationId,
    request: PhotoUploadRequest,
}) {}

export class RequestPhotoUpload extends Domain.Command("RequestPhotoUpload", {
    target: ManagedPhotoKey,
    input: { operationId: PhotoOperationId, request: PhotoUploadRequest },
    events: [PhotoUploadRequested, PhotoOperationResumed],
    rejects: [InvalidPhotoOperation, PhotoOperationConflict],
    reply: { state: PhotoOperationsState },
}) {}
