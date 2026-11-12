import * as Domain from "@alchemy.run/domain";
import { PhotoOperationConflict } from "./photo-operation.rejection.ts";
import { ManagedPhotoKey, PhotoGeneration, PhotoOperationId } from "./photo-operation.ts";

export class AuthorizePhotoExecution extends Domain.Command("AuthorizePhotoExecution", {
    target: ManagedPhotoKey,
    input: { operationId: PhotoOperationId, generation: PhotoGeneration },
    events: [],
    rejects: [PhotoOperationConflict],
}) {}
