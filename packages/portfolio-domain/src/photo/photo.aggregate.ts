import * as Domain from "@alchemy.run/domain";
import * as Match from "effect/Match";
import { AuthorizePhotoExecution } from "./authorize-photo-execution.command.ts";
import {
    CompletePhotoOperation,
    PhotoOperationCompleted,
} from "./complete-photo-operation.command.ts";
import { InvalidPhotoOperation, PhotoOperationConflict } from "./photo-operation.rejection.ts";
import { PhotoOperationResumed } from "./photo-operation-resumed.event.ts";
import {
    ManagedPhotoKey,
    PhotoOperationsState,
    type PhotoOperationRequest,
    type PhotoOperationState,
} from "./photo-operation.ts";
import { PhotoDeletionPrepared, PreparePhotoDeletion } from "./prepare-photo-deletion.command.ts";
import {
    PhotoOperationUncertain,
    RecordPhotoUncertainty,
} from "./record-photo-uncertainty.command.ts";
import { PhotoDeletionRequested, RequestPhotoDeletion } from "./request-photo-deletion.command.ts";
import { PhotoUploadRequested, RequestPhotoUpload } from "./request-photo-upload.command.ts";
import {
    PhotoOperationReconciled,
    ReconcilePhotoOperation,
} from "./reconcile-photo-operation.command.ts";

function sameRequest(left: PhotoOperationRequest, right: PhotoOperationRequest): boolean {
    if (left._tag !== right._tag || left.key !== right.key || left.actor !== right.actor)
        return false;
    if (left._tag === "Upload" && right._tag === "Upload") {
        return (
            left.tag === right.tag &&
            left.mode === right.mode &&
            left.digest === right.digest &&
            left.size === right.size
        );
    }
    return (
        left._tag === "Delete" &&
        right._tag === "Delete" &&
        left.expectedEtag === right.expectedEtag
    );
}

function pending(request: PhotoOperationRequest): PhotoOperationState {
    return {
        request,
        status: "pending",
        etag: null,
        deletionInspected: false,
        deletionEtag: null,
        generation: 0,
    };
}

function update(
    state: typeof PhotoOperationsState.Type,
    operationId: string,
    operation: PhotoOperationState,
) {
    return { ...state, operations: { ...state.operations, [operationId]: operation } };
}

function operationAt(
    state: typeof PhotoOperationsState.Type,
    operationId: string,
): PhotoOperationState | undefined {
    return Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined;
}

/** Per-key reservations fence owner writes. Receipts never determine live R2 availability. */
export class PhotoOperations extends Domain.Aggregate("PhotoOperations", {
    id: ManagedPhotoKey,
    state: PhotoOperationsState,
    initial: { active: null, operations: {} },
    commands: [
        RequestPhotoUpload,
        RequestPhotoDeletion,
        PreparePhotoDeletion,
        AuthorizePhotoExecution,
        CompletePhotoOperation,
        RecordPhotoUncertainty,
        ReconcilePhotoOperation,
    ],
    decide: {
        RequestPhotoUpload: (state, command, context) => {
            const request = command.request;
            if (
                context.id !== request.key ||
                !request.key.startsWith(`${request.tag}/`) ||
                (request.actor === "cats" && request.mode !== "create-only")
            )
                return new InvalidPhotoOperation();
            const previous = operationAt(state, command.operationId);
            if (previous !== undefined) {
                if (!sameRequest(previous.request, request)) return new PhotoOperationConflict();
                return previous.status === "uncertain"
                    ? [
                          new PhotoOperationResumed({
                              operationId: command.operationId,
                              generationAfter: previous.generation + 1,
                          }),
                      ]
                    : [];
            }
            if (state.active !== null) return new PhotoOperationConflict();
            return [new PhotoUploadRequested({ operationId: command.operationId, request })];
        },
        RequestPhotoDeletion: (state, command, context) => {
            if (context.id !== command.request.key) return new PhotoOperationConflict();
            const previous = operationAt(state, command.operationId);
            if (previous !== undefined) {
                if (!sameRequest(previous.request, command.request))
                    return new PhotoOperationConflict();
                return previous.status === "uncertain"
                    ? [
                          new PhotoOperationResumed({
                              operationId: command.operationId,
                              generationAfter: previous.generation + 1,
                          }),
                      ]
                    : [];
            }
            if (state.active !== null) return new PhotoOperationConflict();
            return [
                new PhotoDeletionRequested({
                    operationId: command.operationId,
                    request: command.request,
                }),
            ];
        },
        PreparePhotoDeletion: (state, command) => {
            const operation = operationAt(state, command.operationId);
            if (
                operation === undefined ||
                operation.request._tag !== "Delete" ||
                operation.generation !== command.generation
            )
                return new PhotoOperationConflict();
            if (operation.deletionInspected) return [];
            if (state.active !== command.operationId) return new PhotoOperationConflict();
            return [
                new PhotoDeletionPrepared({ operationId: command.operationId, etag: command.etag }),
            ];
        },
        CompletePhotoOperation: (state, command) => {
            const operation = operationAt(state, command.operationId);
            if (operation === undefined || operation.generation !== command.generation)
                return new PhotoOperationConflict();
            const outcome = command.outcome;
            if (outcome._tag === "Uploaded") {
                if (operation.request._tag !== "Upload") return new PhotoOperationConflict();
                if (operation.status === "uploaded" && operation.etag === outcome.etag) return [];
            } else if (outcome._tag === "Deleted" || outcome._tag === "Changed") {
                if (operation.request._tag !== "Delete" || !operation.deletionInspected)
                    return new PhotoOperationConflict();
                if (operation.status === (outcome._tag === "Deleted" ? "deleted" : "changed"))
                    return [];
            } else {
                if (operation.request._tag !== "Upload" || operation.request.mode !== "create-only")
                    return new PhotoOperationConflict();
                if (operation.status === "collision") return [];
            }
            if (
                state.active !== command.operationId ||
                (operation.status !== "pending" && operation.status !== "uncertain")
            )
                return new PhotoOperationConflict();
            return [new PhotoOperationCompleted({ operationId: command.operationId, outcome })];
        },
        RecordPhotoUncertainty: (state, command) => {
            const operation = operationAt(state, command.operationId);
            if (
                operation === undefined ||
                operation.generation !== command.generation ||
                (operation.request._tag === "Upload" ? "r2-upload" : "r2-delete") !== command.stage
            )
                return new PhotoOperationConflict();
            return operation.status === "pending"
                ? [
                      new PhotoOperationUncertain({
                          operationId: command.operationId,
                          stage: command.stage,
                      }),
                  ]
                : [];
        },
        AuthorizePhotoExecution: (state, command) => {
            const operation = operationAt(state, command.operationId);
            return operation !== undefined &&
                operation.generation === command.generation &&
                operation.status === "pending" &&
                state.active === command.operationId
                ? []
                : new PhotoOperationConflict();
        },
        ReconcilePhotoOperation: (state, command) => {
            if (command.actor !== "owner") return new InvalidPhotoOperation();
            const operation = operationAt(state, command.operationId);
            if (
                operation === undefined ||
                operation.generation !== command.expectedGeneration ||
                state.active !== command.operationId ||
                (operation.status !== "pending" && operation.status !== "uncertain")
            )
                return new PhotoOperationConflict();
            return [
                new PhotoOperationReconciled({
                    operationId: command.operationId,
                    disposition: command.disposition,
                    observedEtag: command.observedEtag,
                    confirmation: command.confirmation,
                    generationAfter: operation.generation + 1,
                }),
            ];
        },
    },
    evolve: {
        PhotoUploadRequested: (state, event) => ({
            ...update(state, event.operationId, pending(event.request)),
            active: event.operationId,
        }),
        PhotoDeletionRequested: (state, event) => ({
            ...update(state, event.operationId, pending(event.request)),
            active: event.operationId,
        }),
        PhotoDeletionPrepared: (state, event) => {
            const operation = operationAt(state, event.operationId);
            return operation === undefined
                ? state
                : update(state, event.operationId, {
                      ...operation,
                      deletionInspected: true,
                      deletionEtag: event.etag,
                  });
        },
        PhotoOperationCompleted: (state, event) => {
            const operation = operationAt(state, event.operationId);
            if (operation === undefined) return state;
            return {
                ...update(state, event.operationId, {
                    ...operation,
                    status: Match.value(event.outcome._tag).pipe(
                        Match.when("Uploaded", (): PhotoOperationState["status"] => "uploaded"),
                        Match.when("Deleted", (): PhotoOperationState["status"] => "deleted"),
                        Match.when("Changed", (): PhotoOperationState["status"] => "changed"),
                        Match.when("Collision", (): PhotoOperationState["status"] => "collision"),
                        Match.exhaustive,
                    ),
                    etag: event.outcome._tag === "Uploaded" ? event.outcome.etag : null,
                }),
                active: state.active === event.operationId ? null : state.active,
            };
        },
        PhotoOperationUncertain: (state, event) => {
            const operation = operationAt(state, event.operationId);
            return operation === undefined
                ? state
                : update(state, event.operationId, { ...operation, status: "uncertain" });
        },
        PhotoOperationResumed: (state, event) => {
            const operation = operationAt(state, event.operationId);
            return operation === undefined
                ? state
                : update(state, event.operationId, {
                      ...operation,
                      status: "pending",
                      generation: event.generationAfter,
                  });
        },
        PhotoOperationReconciled: (state, event) => {
            const operation = operationAt(state, event.operationId);
            if (operation === undefined) return state;
            return {
                ...update(state, event.operationId, {
                    ...operation,
                    generation: event.generationAfter,
                    status: event.disposition === "abort" ? "aborted" : "uncertain",
                }),
                active:
                    event.disposition === "abort" && state.active === event.operationId
                        ? null
                        : state.active,
            };
        },
    },
    reply: {
        RequestPhotoUpload: (state) => ({ state }),
        RequestPhotoDeletion: (state) => ({ state }),
        PreparePhotoDeletion: (state) => ({ state }),
        ReconcilePhotoOperation: (state) => ({ state }),
    },
}) {}
