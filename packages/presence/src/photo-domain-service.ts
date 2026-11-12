import { PhotoOperations } from "@artisann-port/portfolio-domain/photo/photo.aggregate";
import { AuthorizePhotoExecution } from "@artisann-port/portfolio-domain/photo/authorize-photo-execution.command";
import { CompletePhotoOperation } from "@artisann-port/portfolio-domain/photo/complete-photo-operation.command";
import {
    type PhotoOperationOutcome,
    type PhotoOperationState,
    type PhotoOperationRequest,
    type PhotoWriter,
} from "@artisann-port/portfolio-domain/photo/photo-operation";
import { PreparePhotoDeletion } from "@artisann-port/portfolio-domain/photo/prepare-photo-deletion.command";
import { ReconcilePhotoOperation } from "@artisann-port/portfolio-domain/photo/reconcile-photo-operation.command";
import { RequestPhotoUpload } from "@artisann-port/portfolio-domain/photo/request-photo-upload.command";
import { RequestPhotoDeletion } from "@artisann-port/portfolio-domain/photo/request-photo-deletion.command";
import { RecordPhotoUncertainty } from "@artisann-port/portfolio-domain/photo/record-photo-uncertainty.command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class PhotoMutationError extends Schema.TaggedError<PhotoMutationError>()(
    "PhotoMutationError",
    {
        reason: Schema.Literals([
            "InvalidKey",
            "InvalidImage",
            "TooLarge",
            "Collision",
            "OperationConflict",
            "Unavailable",
            "Uncertain",
            "Partial",
            "Unauthorized",
        ]),
        outcome: Schema.Literals(["not-applied", "unknown", "applied"]),
    },
) {}

export interface PhotoOperationStart {
    readonly operation: PhotoOperationState;
    readonly execute: boolean;
}
export interface PhotoOperatorDecision {
    readonly operationId: string;
    readonly expectedGeneration: number;
    readonly disposition: "resume" | "abort";
    readonly observedEtag: string | null;
    readonly actor: PhotoWriter;
    readonly confirmation: "original-writer-stopped";
}
export class PhotoDomainService extends Context.Service<
    PhotoDomainService,
    {
        readonly begin: (
            operationId: string,
            request: PhotoOperationRequest,
        ) => Effect.Effect<PhotoOperationStart, PhotoMutationError>;
        readonly lookup: (
            key: string,
            operationId: string,
        ) => Effect.Effect<PhotoOperationState, PhotoMutationError>;
        readonly authorize: (
            key: string,
            operationId: string,
            generation: number,
        ) => Effect.Effect<void, PhotoMutationError>;
        readonly prepareDeletion: (
            key: string,
            operationId: string,
            generation: number,
            etag: string | null,
        ) => Effect.Effect<PhotoOperationState, PhotoMutationError>;
        readonly complete: (
            key: string,
            operationId: string,
            generation: number,
            outcome: PhotoOperationOutcome,
        ) => Effect.Effect<void, PhotoMutationError>;
        readonly uncertain: (
            key: string,
            operationId: string,
            generation: number,
            stage: "r2-upload" | "r2-delete",
        ) => Effect.Effect<void, PhotoMutationError>;
        readonly reconcile: (
            key: string,
            decision: PhotoOperatorDecision,
        ) => Effect.Effect<PhotoOperationState, PhotoMutationError>;
    }
>()("PhotoDomain.Service") {}

/** The hosting Portfolio model supplies PhotoOperations; this layer never creates another model. */
export const PhotoDomainLive = Layer.effect(
    PhotoDomainService,
    Effect.gen(function* () {
        const operations = yield* PhotoOperations;
        const lookup = Effect.fn("PhotoDomain.lookup")(function* (
            key: string,
            operationId: string,
        ) {
            const state = yield* operations
                .state(key)
                .pipe(
                    Effect.catchDefect(() =>
                        Effect.fail(
                            new PhotoMutationError({ reason: "Unavailable", outcome: "unknown" }),
                        ),
                    ),
                );
            const operation = Object.hasOwn(state.operations, operationId)
                ? state.operations[operationId]
                : undefined;
            if (operation === undefined)
                return yield* new PhotoMutationError({
                    reason: "OperationConflict",
                    outcome: "unknown",
                });
            return operation;
        });
        const begin = Effect.fn("PhotoDomain.begin")(function* (
            operationId: string,
            request: PhotoOperationRequest,
        ) {
            const command =
                request._tag === "Upload"
                    ? new RequestPhotoUpload({ operationId, request })
                    : new RequestPhotoDeletion({ operationId, request });
            const receipt = yield* operations.send(request.key, command).pipe(
                Effect.mapError(
                    () =>
                        new PhotoMutationError({
                            reason: "OperationConflict",
                            outcome: "not-applied",
                        }),
                ),
                Effect.catchDefect(() =>
                    Effect.fail(
                        new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" }),
                    ),
                ),
            );
            const operation = receipt.reply.state.operations[operationId];
            if (operation === undefined)
                return yield* new PhotoMutationError({
                    reason: "Unavailable",
                    outcome: "not-applied",
                });
            return { operation, execute: receipt.events.length > 0 };
        });
        const authorize = Effect.fn("PhotoDomain.authorize")(function* (
            key: string,
            operationId: string,
            generation: number,
        ) {
            yield* operations
                .send(key, new AuthorizePhotoExecution({ operationId, generation }))
                .pipe(
                    Effect.mapError(
                        () =>
                            new PhotoMutationError({
                                reason: "OperationConflict",
                                outcome: "unknown",
                            }),
                    ),
                    Effect.catchDefect(() =>
                        Effect.fail(
                            new PhotoMutationError({ reason: "Unavailable", outcome: "unknown" }),
                        ),
                    ),
                );
        });
        const prepareDeletion = Effect.fn("PhotoDomain.prepareDeletion")(function* (
            key: string,
            operationId: string,
            generation: number,
            etag: string | null,
        ) {
            const receipt = yield* operations
                .send(key, new PreparePhotoDeletion({ operationId, generation, etag }))
                .pipe(
                    Effect.mapError(
                        () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                    ),
                    Effect.catchDefect(() =>
                        Effect.fail(
                            new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                        ),
                    ),
                );
            const operation = receipt.reply.state.operations[operationId];
            if (operation === undefined)
                return yield* new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" });
            return operation;
        });
        const complete = Effect.fn("PhotoDomain.complete")(function* (
            key: string,
            operationId: string,
            generation: number,
            outcome: PhotoOperationOutcome,
        ) {
            const failure =
                outcome._tag === "Uploaded" || outcome._tag === "Deleted"
                    ? new PhotoMutationError({ reason: "Partial", outcome: "applied" })
                    : new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" });
            yield* operations
                .send(key, new CompletePhotoOperation({ operationId, generation, outcome }), {
                    commandId: `${operationId}:complete:${generation}`,
                })
                .pipe(
                    Effect.mapError(() => failure),
                    Effect.catchDefect(() => Effect.fail(failure)),
                );
        });
        const uncertain = Effect.fn("PhotoDomain.uncertain")(function* (
            key: string,
            operationId: string,
            generation: number,
            stage: "r2-upload" | "r2-delete",
        ) {
            yield* operations
                .send(key, new RecordPhotoUncertainty({ operationId, generation, stage }))
                .pipe(
                    Effect.mapError(
                        () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                    ),
                    Effect.catchDefect(() =>
                        Effect.fail(
                            new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                        ),
                    ),
                );
        });
        const reconcile = Effect.fn("PhotoDomain.reconcile")(function* (
            key: string,
            decision: PhotoOperatorDecision,
        ) {
            const receipt = yield* operations.send(key, new ReconcilePhotoOperation(decision)).pipe(
                Effect.mapError(
                    () =>
                        new PhotoMutationError({ reason: "OperationConflict", outcome: "unknown" }),
                ),
                Effect.catchDefect(() =>
                    Effect.fail(
                        new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" }),
                    ),
                ),
            );
            const operation = receipt.reply.state.operations[decision.operationId];
            if (operation === undefined)
                return yield* new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" });
            return operation;
        });
        return PhotoDomainService.of({
            begin,
            lookup,
            authorize,
            prepareDeletion,
            complete,
            uncertain,
            reconcile,
        });
    }),
);
