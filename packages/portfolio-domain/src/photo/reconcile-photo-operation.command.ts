import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { InvalidPhotoOperation, PhotoOperationConflict } from "./photo-operation.rejection.ts";
import {
    ManagedPhotoKey,
    PhotoGeneration,
    PhotoOperationId,
    PhotoOperationsState,
    PhotoWriter,
} from "./photo-operation.ts";

export class PhotoOperationReconciled extends Domain.Event("PhotoOperationReconciled", {
    operationId: PhotoOperationId,
    disposition: Schema.Literals(["resume", "abort"]),
    generationAfter: PhotoGeneration,
    observedEtag: Schema.NullOr(Schema.NonEmptyString),
    confirmation: Schema.Literal("original-writer-stopped"),
}) {}

/** The operator acknowledges that the old execution and its R2 requests have ended. */
export class ReconcilePhotoOperation extends Domain.Command("ReconcilePhotoOperation", {
    target: ManagedPhotoKey,
    input: {
        operationId: PhotoOperationId,
        expectedGeneration: PhotoGeneration,
        disposition: Schema.Literals(["resume", "abort"]),
        observedEtag: Schema.NullOr(Schema.NonEmptyString),
        actor: PhotoWriter,
        confirmation: Schema.Literal("original-writer-stopped"),
    },
    events: [PhotoOperationReconciled],
    rejects: [InvalidPhotoOperation, PhotoOperationConflict],
    reply: { state: PhotoOperationsState },
}) {}
