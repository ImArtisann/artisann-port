import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ManagedPhotoKey } from "@artisann-port/portfolio-domain/photo/photo-operation";
import {
    ApiUnavailable,
    ContentWriteError,
    PhotoWriteError,
    WriterUnauthorized,
} from "@artisann-port/presence/api-errors";
import {
    ContentWriterAction,
    ContentWriterState,
    ContentWriterResult,
} from "@artisann-port/presence/content-writer";
import { PhotoPage, type PhotoTag, type PhotosError } from "@artisann-port/presence/photos";
import { PresenceSnapshot } from "@artisann-port/presence/schema";
import { PhotoMutationError } from "@artisann-port/presence/photo-owner-client";
import { BotConfig } from "./config.ts";

export class BotStorageError extends Schema.TaggedError<BotStorageError>()(
    "Discord.BotStorageError",
    {
        operation: Schema.String,
        status: Schema.NullOr(Schema.Finite),
        reason: Schema.String,
        /** Present when the owner must reconcile this photo operation before retrying. */
        operationId: Schema.optional(Schema.String),
    },
) {}
export class ContentValidationError extends Schema.TaggedError<ContentValidationError>()(
    "Discord.ContentValidationError",
    {
        message: Schema.String,
    },
) {}

export type ApiStorageFailure =
    | ApiUnavailable
    | ContentWriteError
    | WriterUnauthorized
    | PhotoWriteError
    | PhotosError
    | Cause.TimeoutError;
type ClientFailure = ApiUnavailable | ContentWriteError | WriterUnauthorized | PhotoWriteError;

export interface BotPortfolioClientService {
    readonly contentState: Effect.Effect<ContentWriterState, ClientFailure>;
    readonly applyContent: (
        action: ContentWriterAction,
    ) => Effect.Effect<ContentWriterResult, ClientFailure>;
    readonly photoPage: (tag: PhotoTag, cursor?: string) => Effect.Effect<PhotoPage, ClientFailure>;
    readonly uploadPhoto: (
        tag: PhotoTag,
        interactionId: string,
        bytes: Uint8Array,
    ) => Effect.Effect<string, ClientFailure>;
    readonly deletePhoto: (
        tag: PhotoTag,
        photoId: string,
        operationId: string,
    ) => Effect.Effect<void, ClientFailure>;
    readonly presence: Effect.Effect<PresenceSnapshot, ClientFailure>;
    readonly publishPresence: (
        snapshot: PresenceSnapshot,
    ) => Effect.Effect<PresenceSnapshot, ClientFailure>;
}
export class BotPortfolioClient extends Context.Service<
    BotPortfolioClient,
    BotPortfolioClientService
>()("Discord.PortfolioClient") {}

const UploadedPhoto = Schema.Struct({ key: ManagedPhotoKey });
const DeletedPhoto = Schema.Struct({ key: Schema.String, operationId: Schema.String });

export const BotPortfolioClientLive = Layer.effect(
    BotPortfolioClient,
    Effect.gen(function* () {
        const config = yield* BotConfig;
        const client = yield* HttpClient.HttpClient;
        const base = new URL(config.portfolioApiUrl);
        const endpoint = (path: string) => new URL(path, base).href;
        const unavailable = () => new ApiUnavailable({ operation: "portfolio.request" });
        const auth = (request: HttpClientRequest.HttpClientRequest) =>
            request.pipe(
                HttpClientRequest.bearerToken(config.contentWriterToken),
                HttpClientRequest.acceptJson,
            );

        const execute = Effect.fn("BotPortfolio.request")(function* (
            request: HttpClientRequest.HttpClientRequest,
            scope: "content" | "photo" | "presence",
        ) {
            const response = yield* client.execute(request).pipe(Effect.mapError(unavailable));
            if (response.status === 401 || response.status === 403)
                return yield* new WriterUnauthorized();
            if (response.status < 200 || response.status >= 300) {
                if (scope === "content") {
                    if (response.status === 413)
                        return yield* new ContentWriteError({ kind: "capacity" });
                    const failure = yield* HttpClientResponse.schemaBodyJson(ContentWriteError)(
                        response,
                    ).pipe(Effect.option);
                    if (Option.isSome(failure)) return yield* failure.value;
                }
                if (scope === "photo") {
                    if (response.status === 413)
                        return yield* new PhotoWriteError({ reason: "TooLarge" });
                    const failure = yield* HttpClientResponse.schemaBodyJson(PhotoMutationError)(
                        response,
                    ).pipe(Effect.option);
                    if (
                        Option.isSome(failure) &&
                        (failure.value.reason === "InvalidKey" ||
                            failure.value.reason === "InvalidImage" ||
                            failure.value.reason === "TooLarge")
                    )
                        return yield* new PhotoWriteError({ reason: failure.value.reason });
                }
                return yield* unavailable();
            }
            return response;
        });
        const decode = <A, I>(
            request: HttpClientRequest.HttpClientRequest,
            schema: Schema.Codec<A, I>,
            scope: "content" | "photo" | "presence",
        ) =>
            execute(request, scope).pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
                Effect.mapError((error) =>
                    Schema.is(ContentWriteError)(error) ||
                    Schema.is(WriterUnauthorized)(error) ||
                    Schema.is(PhotoWriteError)(error)
                        ? error
                        : unavailable(),
                ),
            );
        const contentUrl = endpoint("/api/writer/content");
        const presenceUrl = endpoint("/api/writer/presence");
        const photosUrl = endpoint("/api/writer/photos");
        const contentState = decode(
            auth(HttpClientRequest.get(contentUrl)),
            ContentWriterState,
            "content",
        );
        const applyContent = Effect.fn("BotPortfolio.applyContent")(function* (
            action: ContentWriterAction,
        ) {
            const id = yield* Effect.sync(() => crypto.randomUUID());
            const request = yield* HttpClientRequest.schemaBodyJson(ContentWriterAction)(
                auth(HttpClientRequest.post(contentUrl)).pipe(
                    HttpClientRequest.setHeader("x-command-id", id),
                ),
                action,
            ).pipe(Effect.mapError(unavailable));
            return yield* decode(request, ContentWriterResult, "content");
        });
        const photoPage = Effect.fn("BotPortfolio.photoPage")(function* (
            tag: PhotoTag,
            cursor?: string,
        ) {
            let request = HttpClientRequest.get(endpoint("/api/photos")).pipe(
                HttpClientRequest.setUrlParam("tag", tag),
                HttpClientRequest.acceptJson,
            );
            if (cursor !== undefined)
                request = HttpClientRequest.setUrlParam(request, "cursor", cursor);
            return yield* decode(request, PhotoPage, "photo");
        });
        const uploadPhoto = Effect.fn("BotPortfolio.uploadPhoto")(function* (
            tag: PhotoTag,
            interactionId: string,
            bytes: Uint8Array,
        ) {
            const request = auth(HttpClientRequest.post(photosUrl)).pipe(
                HttpClientRequest.setUrlParams({ key: `${tag}/${interactionId}.webp`, tag }),
                HttpClientRequest.setHeader(
                    "x-photo-operation-id",
                    `discord:upload:${tag}:${interactionId}`,
                ),
                HttpClientRequest.setHeader("x-photo-writer", "discord"),
                HttpClientRequest.bodyUint8Array(bytes, "image/webp"),
            );
            return (yield* decode(request, UploadedPhoto, "photo")).key;
        });
        const deletePhoto = Effect.fn("BotPortfolio.deletePhoto")(function* (
            tag: PhotoTag,
            photoId: string,
            operationId: string,
        ) {
            const request = auth(HttpClientRequest.delete(photosUrl)).pipe(
                HttpClientRequest.setUrlParam("key", `${tag}/${photoId}.webp`),
                HttpClientRequest.setHeader("x-photo-operation-id", operationId),
                HttpClientRequest.setHeader("x-photo-writer", "discord"),
            );
            yield* decode(request, DeletedPhoto, "photo");
        });
        const presence = decode(
            auth(HttpClientRequest.get(presenceUrl)),
            PresenceSnapshot,
            "presence",
        );
        const publishPresence = Effect.fn("BotPortfolio.publishPresence")(function* (
            snapshot: PresenceSnapshot,
        ) {
            const request = yield* HttpClientRequest.schemaBodyJson(PresenceSnapshot)(
                auth(HttpClientRequest.post(presenceUrl)),
                snapshot,
            ).pipe(Effect.mapError(unavailable));
            return yield* decode(request, PresenceSnapshot, "presence");
        });
        return BotPortfolioClient.of({
            contentState,
            applyContent,
            photoPage,
            uploadPhoto,
            deletePhoto,
            presence,
            publishPresence,
        });
    }),
);

export function apiStorageError(operation: string, error: ApiStorageFailure): BotStorageError {
    if (Cause.isTimeoutError(error))
        return new BotStorageError({ operation, status: null, reason: "Timeout" });
    if (Schema.is(ContentWriteError)(error)) {
        if (error.kind === "conflict")
            return new BotStorageError({ operation, status: 409, reason: "Conflict" });
        if (error.kind === "validation" || error.kind === "capacity")
            return new BotStorageError({ operation, status: 422, reason: "Validation" });
    }
    if (Schema.is(WriterUnauthorized)(error))
        return new BotStorageError({ operation, status: 401, reason: "Unauthorized" });
    if (Schema.is(PhotoWriteError)(error))
        return new BotStorageError({ operation, status: 422, reason: error.reason });
    return new BotStorageError({ operation, status: null, reason: "Unavailable" });
}
export const boundedApiOperation = <A, R>(
    operation: string,
    effect: Effect.Effect<A, ApiStorageFailure, R>,
): Effect.Effect<A, BotStorageError, R> =>
    effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((error) => apiStorageError(operation, error)),
    );
