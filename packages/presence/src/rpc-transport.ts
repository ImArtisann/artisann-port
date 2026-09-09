import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

/** Pin the full endpoint: RpcClient's default prependUrl adds a trailing slash. */
export function publicRpcProtocol(url: string) {
    return RpcClient.layerProtocolHttp({
        url,
        transformClient: (client) =>
            HttpClient.mapRequest(client, HttpClientRequest.setUrl(url)).pipe(
                HttpClient.transformResponse(
                    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                ),
            ),
    }).pipe(Layer.provide(RpcSerialization.layerNdjson));
}

export function writerRpcProtocol(url: string, token: Redacted.Redacted<string>) {
    return RpcClient.layerProtocolHttp({
        url,
        transformClient: (client) =>
            HttpClient.mapRequest(client, (request) =>
                request.pipe(HttpClientRequest.setUrl(url), HttpClientRequest.bearerToken(token)),
            ).pipe(
                HttpClient.transformResponse(
                    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                ),
            ),
    }).pipe(Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 32 * 1024 * 1024 })));
}
