import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import {
    ApiUnavailable,
    ContentWriteError,
    PhotoWriteError,
    WriterUnauthorized,
} from "@artisann-port/presence/api-errors";
import { PublicRpcs, WriterRpcs } from "@artisann-port/presence/rpc";
import { publicRpcProtocol, writerRpcProtocol } from "@artisann-port/presence/rpc-transport";
import { portfolioEndpoints } from "@artisann-port/presence/config";
import type { PhotosError } from "@artisann-port/presence/photos";
import { BotConfig } from "./config.ts";

export class BotStorageError extends Schema.TaggedError<BotStorageError>()(
    "Discord.BotStorageError",
    {
        operation: Schema.String,
        status: Schema.NullOr(Schema.Finite),
        reason: Schema.String,
    },
) {}

export class ContentValidationError extends Schema.TaggedError<ContentValidationError>()(
    "Discord.ContentValidationError",
    {
        message: Schema.String,
    },
) {}

export type PublicClientApi = RpcClient.RpcClient.Flat<
    RpcGroup.Rpcs<typeof PublicRpcs>,
    RpcClientError
>;
export type WriterClientApi = RpcClient.RpcClient.Flat<
    RpcGroup.Rpcs<typeof WriterRpcs>,
    RpcClientError
>;

export interface BotRpcClientsService {
    readonly public: PublicClientApi;
    readonly writer: WriterClientApi;
}

/**
 * Mounted AtomRpc clients. Protocol HTTP is provided at layer creation.
 * `RpcClient.Flat` infers `EncodingServices | DecodingServices` as `unknown`
 * on the generic client; PublicRpcs/WriterRpcs use plain Schema payloads with
 * no encoding/decoding services, so the concrete call environment is `never`.
 *
 * @effect-expect-leaking unknown
 */
export class BotRpcClients extends Context.Service<BotRpcClients, BotRpcClientsService>()(
    "Discord.RpcClients",
) {}

/** One registry and two mounted AtomRpc runtimes for the entire bot process. */
export const BotRpcClientsLive = Layer.effect(
    BotRpcClients,
    Effect.gen(function* () {
        const config = yield* BotConfig;
        const httpClient = yield* HttpClient.HttpClient;
        const http = Layer.succeed(HttpClient.HttpClient, httpClient);
        const endpoints = portfolioEndpoints(config.portfolioApiUrl);
        class PublicClient extends AtomRpc.Service<PublicClient>()("Discord.PublicRpc", {
            group: PublicRpcs,
            protocol: publicRpcProtocol(endpoints.rpcUrl).pipe(Layer.provide(http)),
            disableTracing: true,
        }) {}
        class WriterClient extends AtomRpc.Service<WriterClient>()("Discord.WriterRpc", {
            group: WriterRpcs,
            protocol: writerRpcProtocol(endpoints.writerRpcUrl, config.contentWriterToken).pipe(
                Layer.provide(http),
            ),
            disableTracing: true,
        }) {}
        const registry = yield* AtomRegistry.AtomRegistry;
        yield* AtomRegistry.mount(registry, PublicClient.runtime);
        yield* AtomRegistry.mount(registry, WriterClient.runtime);
        const publicContext = yield* AtomRegistry.getResult(registry, PublicClient.runtime);
        const writerContext = yield* AtomRegistry.getResult(registry, WriterClient.runtime);
        return BotRpcClients.of({
            public: Context.get(publicContext, PublicClient),
            writer: Context.get(writerContext, WriterClient),
        });
    }),
).pipe(Layer.provide(AtomRegistry.layerOptions({ defaultIdleTTL: 0, timeoutResolution: 1 })));

/** Failures that may cross the typed RPC boundary before client sanitization. */
export type RpcStorageFailure =
    | RpcClientError
    | ApiUnavailable
    | ContentWriteError
    | WriterUnauthorized
    | PhotoWriteError
    | PhotosError
    | Cause.TimeoutError;

const isContentWriteError = Schema.is(ContentWriteError);
const isWriterUnauthorized = Schema.is(WriterUnauthorized);
const isPhotoWriteError = Schema.is(PhotoWriteError);

/** Authored diagnosis only; never leak provider causes, bodies or credentials. */
export function rpcStorageError(operation: string, error: RpcStorageFailure): BotStorageError {
    if (Cause.isTimeoutError(error))
        return new BotStorageError({ operation, status: null, reason: "Timeout" });
    if (isContentWriteError(error)) {
        if (error.kind === "conflict")
            return new BotStorageError({ operation, status: 409, reason: "Conflict" });
        if (error.kind === "validation" || error.kind === "capacity")
            return new BotStorageError({ operation, status: 422, reason: "Validation" });
    }
    if (isWriterUnauthorized(error))
        return new BotStorageError({ operation, status: 401, reason: "Unauthorized" });
    if (isPhotoWriteError(error))
        return new BotStorageError({ operation, status: 422, reason: error.reason });
    return new BotStorageError({ operation, status: null, reason: "Unavailable" });
}

export const boundedRpcOperation = <A, R>(
    operation: string,
    effect: Effect.Effect<A, RpcStorageFailure, R>,
): Effect.Effect<A, BotStorageError, R> =>
    effect.pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((error) => rpcStorageError(operation, error)),
    );
