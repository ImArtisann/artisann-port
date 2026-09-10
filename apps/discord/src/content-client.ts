import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Duration from "effect/Duration";
import { RateLimiter } from "dfx/RateLimit";
import type { ContentWriterAction } from "@artisann-port/presence/content-writer";
import { SiteContent } from "@artisann-port/presence/content";
import { ContentWriteError } from "@artisann-port/presence/api-errors";
import {
    BotRpcClients,
    boundedRpcOperation,
    rpcStorageError,
    BotStorageError,
    ContentValidationError,
    type RpcStorageFailure,
} from "./rpc-client.ts";

export interface NoteApproval {
    readonly id: string;
    readonly name: string | null;
    readonly body: string;
    readonly submittedAt: string;
}

export interface BotContentClientService {
    readonly loadContent: Effect.Effect<SiteContent, BotStorageError>;
    readonly updateContent: (
        change: (current: SiteContent) => Result.Result<SiteContent, ContentValidationError>,
    ) => Effect.Effect<SiteContent, BotStorageError | ContentValidationError>;
    readonly approveNote: (
        approval: NoteApproval,
    ) => Effect.Effect<"approved" | "already-approved", BotStorageError | ContentValidationError>;
    readonly rejectNote: (
        id: string,
    ) => Effect.Effect<"rejected" | "already-rejected" | "already-approved", BotStorageError>;
    readonly deleteNote: (id: string) => Effect.Effect<"deleted" | "not-found", BotStorageError>;
}

export class BotContentClient extends Context.Service<BotContentClient, BotContentClientService>()(
    "Discord.BotContentClient",
) {}

const siteContent = Schema.decodeUnknownEffect(SiteContent);

const isContentConflict = (
    error: RpcStorageFailure | BotStorageError | ContentValidationError,
): error is ContentWriteError => Schema.is(ContentWriteError)(error) && error.kind === "conflict";

export const BotContentClientLive: Layer.Layer<
    BotContentClient,
    never,
    BotRpcClients | RateLimiter
> = Layer.effect(
    BotContentClient,
    Effect.gen(function* () {
        const clients = yield* BotRpcClients;
        const rateLimiter = yield* RateLimiter;
        const writePermit = yield* Semaphore.make(1);

        const readState = Effect.fn("BotContentClient.readState")(function* () {
            return yield* boundedRpcOperation("loadContent", clients.writer("content.state", {}));
        });

        const apply = (operation: string, action: ContentWriterAction, limited: boolean) =>
            Effect.gen(function* () {
                if (limited)
                    yield* rateLimiter.maybeWait("kv:site-content", Duration.seconds(1), 1);
                return yield* clients.writer("content.apply", action);
            }).pipe(
                Effect.timeout("15 seconds"),
                Effect.mapError((error) => rpcStorageError(operation, error)),
            );

        const loadContent = readState().pipe(
            Effect.map((state) => state.content),
            Effect.withSpan("BotContentClient.loadContent"),
        );

        const updateContent = Effect.fn("BotContentClient.updateContent")(function* (
            change: (current: SiteContent) => Result.Result<SiteContent, ContentValidationError>,
        ) {
            return yield* writePermit.withPermits(1)(
                Effect.gen(function* () {
                    const current = yield* readState();
                    const next = change(current.content);
                    if (Result.isFailure(next)) return yield* next.failure;
                    const now = yield* DateTime.now;
                    const stamped: SiteContent = {
                        ...next.success,
                        updatedAt: DateTime.formatIso(now),
                    };
                    yield* siteContent(stamped).pipe(
                        Effect.mapError(
                            () =>
                                new ContentValidationError({
                                    message: "The edited document failed validation",
                                }),
                        ),
                    );
                    const result = yield* Effect.gen(function* () {
                        yield* rateLimiter.maybeWait("kv:site-content", Duration.seconds(1), 1);
                        return yield* clients.writer("content.apply", {
                            action: "replace",
                            revision: current.revision,
                            content: stamped,
                        });
                    }).pipe(Effect.timeout("15 seconds"));
                    if (
                        result.outcome !== "updated" ||
                        result.state.publishedRevision < result.state.revision
                    ) {
                        return yield* new BotStorageError({
                            operation: "updateContent",
                            status: 503,
                            reason: "Unavailable",
                        });
                    }
                    return result.state.content;
                }).pipe(
                    Effect.retry({ times: 2, while: isContentConflict }),
                    Effect.mapError((error) =>
                        error._tag === "Discord.BotStorageError" ||
                        error._tag === "Discord.ContentValidationError"
                            ? error
                            : rpcStorageError("updateContent", error),
                    ),
                ),
            );
        });

        const approveNote = Effect.fn("BotContentClient.approveNote")(function* (
            approval: NoteApproval,
        ) {
            return yield* writePermit.withPermits(1)(
                Effect.gen(function* () {
                    const result = yield* apply(
                        "approveNote",
                        {
                            action: "approve",
                            id: approval.id,
                            name: approval.name,
                            body: approval.body,
                            submittedAt: approval.submittedAt,
                        },
                        true,
                    );
                    if (result.outcome === "already-rejected") {
                        return yield* new ContentValidationError({
                            message: "This note was already rejected.",
                        });
                    }
                    if (
                        (result.outcome !== "approved" && result.outcome !== "already-approved") ||
                        result.state.publishedRevision < result.state.revision
                    ) {
                        return yield* new BotStorageError({
                            operation: "approveNote",
                            status: 503,
                            reason: "Unavailable",
                        });
                    }
                    return result.outcome;
                }),
            );
        });

        const rejectNote = Effect.fn("BotContentClient.rejectNote")(function* (id: string) {
            return yield* writePermit.withPermits(1)(
                Effect.gen(function* () {
                    const result = yield* apply("rejectNote", { action: "reject", id }, false);
                    if (
                        result.outcome !== "rejected" &&
                        result.outcome !== "already-rejected" &&
                        result.outcome !== "already-approved"
                    ) {
                        return yield* new BotStorageError({
                            operation: "rejectNote",
                            status: 503,
                            reason: "Unavailable",
                        });
                    }
                    if (
                        result.outcome === "already-approved" &&
                        result.state.publishedRevision < result.state.revision
                    ) {
                        return yield* new BotStorageError({
                            operation: "rejectNote",
                            status: 503,
                            reason: "Unavailable",
                        });
                    }
                    return result.outcome;
                }),
            );
        });

        const deleteNote = Effect.fn("BotContentClient.deleteNote")(function* (id: string) {
            return yield* writePermit.withPermits(1)(
                Effect.gen(function* () {
                    const result = yield* apply("deleteNote", { action: "delete", id }, true);
                    if (
                        (result.outcome !== "deleted" && result.outcome !== "not-found") ||
                        result.state.publishedRevision < result.state.revision
                    ) {
                        return yield* new BotStorageError({
                            operation: "deleteNote",
                            status: 503,
                            reason: "Unavailable",
                        });
                    }
                    return result.outcome;
                }),
            );
        });

        return BotContentClient.of({
            loadContent,
            updateContent,
            approveNote,
            rejectNote,
            deleteNote,
        });
    }),
);
