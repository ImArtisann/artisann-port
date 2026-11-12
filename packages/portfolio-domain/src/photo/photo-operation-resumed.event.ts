import * as Domain from "@alchemy.run/domain";
import { PhotoGeneration, PhotoOperationId } from "./photo-operation.ts";

export class PhotoOperationResumed extends Domain.Event("PhotoOperationResumed", {
    operationId: PhotoOperationId,
    generationAfter: PhotoGeneration,
}) {}
