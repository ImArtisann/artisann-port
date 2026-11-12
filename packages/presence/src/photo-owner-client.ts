import {
    ManagedPhotoKey,
    PhotoCollection,
    PhotoOperationId,
} from "@artisann-port/portfolio-domain/photo/photo-operation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { PhotoMutationError } from "./photo-domain-service.ts";
import {
    PhotoUploadReceipt as UploadReceipt,
    PhotoDeletionReceipt as DeleteReceipt,
} from "./photos-service.ts";

export { PhotoMutationError } from "./photo-domain-service.ts";

export interface PhotoOwnerConfigValue {
    readonly origin: string;
    readonly token: Redacted.Redacted<string>;
}
export class PhotoOwnerConfig extends Context.Service<PhotoOwnerConfig, PhotoOwnerConfigValue>()(
    "PhotoOwner.Config",
) {}

const UploadInput = Schema.Struct({
    key: ManagedPhotoKey,
    tag: PhotoCollection,
    operationId: PhotoOperationId,
});
const DeleteInput = Schema.Struct({
    key: ManagedPhotoKey,
    operationId: PhotoOperationId,
    expectedEtag: Schema.optionalKey(Schema.NonEmptyString),
    expectedUploadOperationId: Schema.optionalKey(PhotoOperationId),
});

export interface PhotoOwnerUploadInput extends Schema.Schema.Type<typeof UploadInput> {
    readonly bytes: Uint8Array;
}
export type PhotoOwnerDeletionInput = typeof DeleteInput.Type;
export type PhotoOwnerUploadReceipt = typeof UploadReceipt.Type;
export type PhotoOwnerDeletionReceipt = typeof DeleteReceipt.Type;

export class PhotoOwnerClient extends Context.Service<
    PhotoOwnerClient,
    {
        readonly upload: (
            input: PhotoOwnerUploadInput,
        ) => Effect.Effect<PhotoOwnerUploadReceipt, PhotoMutationError>;
        readonly delete: (
            input: PhotoOwnerDeletionInput,
        ) => Effect.Effect<PhotoOwnerDeletionReceipt, PhotoMutationError>;
    }
>()("PhotoOwner.Client") {}

const uncertain = () => new PhotoMutationError({ reason: "Uncertain", outcome: "unknown" });
const LOOPBACK_HOSTS = {
    localhost: true,
    "127.0.0.1": true,
    "[::1]": true,
} as const;

export const PhotoOwnerClientLive = Layer.effect(
    PhotoOwnerClient,
    Effect.gen(function* () {
        const config = yield* PhotoOwnerConfig;
        const client = yield* HttpClient.HttpClient;
        const base = yield* Effect.try({
            try: () => new URL(config.origin),
            catch: () => new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" }),
        });
        if (
            // The writer token rides on every request; plaintext is acceptable only on loopback.
            !(
                base.protocol === "https:" ||
                (base.protocol === "http:" && Object.hasOwn(LOOPBACK_HOSTS, base.hostname))
            ) ||
            base.username !== "" ||
            base.password !== "" ||
            base.pathname !== "/" ||
            base.search !== "" ||
            base.hash !== "" ||
            Redacted.value(config.token).trim() === ""
        ) {
            return yield* new PhotoMutationError({ reason: "Unavailable", outcome: "not-applied" });
        }
        const endpoint = new URL("/api/writer/photos", base).href;
        const execute = Effect.fn("PhotoOwner.request")(function* (
            request: HttpClientRequest.HttpClientRequest,
        ) {
            const response = yield* client.execute(request).pipe(Effect.mapError(uncertain));
            if (response.status === 401 || response.status === 403) {
                return yield* new PhotoMutationError({
                    reason: "Unauthorized",
                    outcome: "not-applied",
                });
            }
            if (response.status < 200 || response.status >= 300) {
                const failure = yield* HttpClientResponse.schemaBodyJson(PhotoMutationError)(
                    response,
                ).pipe(Effect.mapError(uncertain));
                return yield* failure;
            }
            return response;
        });
        const upload = Effect.fn("PhotoOwner.upload")(
            function* (input: PhotoOwnerUploadInput) {
                yield* Schema.decodeUnknownEffect(UploadInput)(input).pipe(
                    Effect.mapError(
                        () =>
                            new PhotoMutationError({
                                reason: "InvalidKey",
                                outcome: "not-applied",
                            }),
                    ),
                );
                const request = HttpClientRequest.post(endpoint).pipe(
                    HttpClientRequest.setUrlParams({ key: input.key, tag: input.tag }),
                    HttpClientRequest.bearerToken(config.token),
                    HttpClientRequest.acceptJson,
                    HttpClientRequest.setHeader("x-photo-operation-id", input.operationId),
                    HttpClientRequest.setHeader("x-photo-writer", "cats"),
                    HttpClientRequest.setHeader("if-none-match", "*"),
                    HttpClientRequest.bodyUint8Array(input.bytes, "image/webp"),
                );
                const response = yield* execute(request);
                const receipt = yield* HttpClientResponse.schemaBodyJson(UploadReceipt)(
                    response,
                ).pipe(Effect.mapError(uncertain));
                if (
                    receipt.key !== input.key ||
                    receipt.tag !== input.tag ||
                    receipt.operationId !== input.operationId ||
                    new URL(receipt.url).pathname !== `/${input.key}`
                )
                    return yield* uncertain();
                return receipt;
            },
            Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () => Effect.fail(uncertain()),
            }),
        );
        const deletePhoto = Effect.fn("PhotoOwner.delete")(
            function* (input: PhotoOwnerDeletionInput) {
                yield* Schema.decodeUnknownEffect(DeleteInput)(input).pipe(
                    Effect.mapError(
                        () =>
                            new PhotoMutationError({
                                reason: "InvalidKey",
                                outcome: "not-applied",
                            }),
                    ),
                );
                let request = HttpClientRequest.delete(endpoint).pipe(
                    HttpClientRequest.setUrlParam("key", input.key),
                    HttpClientRequest.bearerToken(config.token),
                    HttpClientRequest.acceptJson,
                    HttpClientRequest.setHeader("x-photo-operation-id", input.operationId),
                    HttpClientRequest.setHeader("x-photo-writer", "cats"),
                );
                if (input.expectedEtag !== undefined)
                    request = HttpClientRequest.setHeader(request, "if-match", input.expectedEtag);
                if (input.expectedUploadOperationId !== undefined)
                    request = HttpClientRequest.setHeader(
                        request,
                        "x-photo-expected-operation-id",
                        input.expectedUploadOperationId,
                    );
                const response = yield* execute(request);
                const receipt = yield* HttpClientResponse.schemaBodyJson(DeleteReceipt)(
                    response,
                ).pipe(Effect.mapError(uncertain));
                if (receipt.key !== input.key || receipt.operationId !== input.operationId)
                    return yield* uncertain();
                return receipt;
            },
            Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () => Effect.fail(uncertain()),
            }),
        );
        return PhotoOwnerClient.of({ upload, delete: deletePhoto });
    }),
);
