import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { WriterUnauthorized } from "./api-errors.ts";
import { CmsContentService } from "./cms-service.ts";
import { NOTES_RPC_PATH, PUBLIC_RPC_PATH, WRITER_RPC_PATH } from "./config.ts";
import { GithubService } from "./github.ts";
import { NotesService, originAllowed } from "./notes-service.ts";
import { PhotosService } from "./photos-service.ts";
import { PresenceService } from "./presence-service.ts";
import { NotesRpcs, PublicRpcs, WriterAuth, WriterRpcs } from "./rpc.ts";
import { WeatherService } from "./weather-service.ts";

type Domains =
    | CmsContentService
    | GithubService
    | NotesService
    | PhotosService
    | PresenceService
    | WeatherService;

const PublicHandlers = PublicRpcs.toLayer(
    Effect.gen(function* () {
        const content = yield* CmsContentService;
        const photos = yield* PhotosService;
        const github = yield* GithubService;
        const weather = yield* WeatherService;
        return PublicRpcs.of({
            "content.get": () => content.get,
            "photos.list": ({ tag, cursor }) => photos.listPage(tag, cursor),
            "github.get": () => github.get,
            "weather.get": () => weather.get,
        });
    }),
);

const WriterHandlers = WriterRpcs.toLayer(
    Effect.gen(function* () {
        const content = yield* CmsContentService;
        const photos = yield* PhotosService;
        const presence = yield* PresenceService;
        return WriterRpcs.of({
            "presence.get": () => presence.get,
            "presence.publish": ({ snapshot }) => presence.publish(snapshot),
            "content.state": () => content.readState,
            "content.apply": (action) => content.apply(action),
            "photos.upload": ({ tag, interactionId, bytes }) =>
                photos.upload(tag, interactionId, bytes),
            "photos.delete": ({ tag, photoId }) => photos.delete(tag, photoId),
        });
    }),
);

/** Check the actual HTTP header, not client-supplied RPC metadata. */
function authorized(request: Request, token: Redacted.Redacted<string>): boolean {
    const secret = Redacted.value(token);
    return secret.length > 0 && request.headers.get("authorization") === `Bearer ${secret}`;
}

/** Read actual streamed bytes; neither Content-Length nor a stalled reader can bypass the cap. */
function readRpcBody(request: Request, maximum: number): Effect.Effect<Uint8Array | null> {
    const body = request.body;
    if (!body) return Effect.succeed(new Uint8Array());
    return Stream.fromReadableStream({
        evaluate: () => body,
        onError: () => "rpc-body" as const,
    }).pipe(
        Stream.mapAccumEffect(
            () => 0,
            (size, chunk: Uint8Array) => {
                const next = size + chunk.byteLength;
                if (next > maximum) return Effect.fail("rpc-body" as const);
                return Effect.succeed([next, [chunk]] as const);
            },
        ),
        Stream.runCollect,
        Effect.map((chunks) => {
            let length = 0;
            for (const chunk of chunks) length += chunk.byteLength;
            const assembled = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                assembled.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return assembled;
        }),
        Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.succeed(null),
        }),
        Effect.orElseSucceed(() => null),
    );
}

export interface RpcRequestConfig {
    readonly writerToken: Redacted.Redacted<string>;
    readonly websiteOrigin: string;
}

function rpcHttpApp(
    request: Request,
    domains: Layer.Layer<Domains>,
    config: RpcRequestConfig,
    writer: boolean,
    notes: boolean,
    origin: string | null,
) {
    if (writer) {
        const auth = Layer.succeed(WriterAuth, (effect) =>
            authorized(request, config.writerToken)
                ? effect
                : Effect.fail(new WriterUnauthorized()),
        );
        const handlers = Layer.mergeAll(
            WriterHandlers,
            auth,
            RpcSerialization.layerSchemaBinary({ maxFrameSize: 32 * 1024 * 1024 }),
        ).pipe(Layer.provide(domains));
        return RpcServer.toHttpEffect(WriterRpcs).pipe(Effect.flatten, Effect.provide(handlers));
    }
    if (notes) {
        const handlers = NotesRpcs.toLayer(
            Effect.gen(function* () {
                const service = yield* NotesService;
                return NotesRpcs.of({
                    "notes.submit": (submission) =>
                        service.submit(submission, {
                            origin,
                            ip: request.headers.get("cf-connecting-ip"),
                        }),
                });
            }),
        ).pipe(Layer.provide(domains));
        return RpcServer.toHttpEffect(NotesRpcs).pipe(
            Effect.flatten,
            Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
        );
    }
    const handlers = PublicHandlers.pipe(Layer.provide(domains));
    return RpcServer.toHttpEffect(PublicRpcs).pipe(
        Effect.flatten,
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
}

/** The caller supplies one scoped composition; handlers contain no provider/storage implementation. */
export function handleRpcRequest(
    request: Request,
    domains: Layer.Layer<Domains>,
    config: RpcRequestConfig,
): Promise<Response> {
    const path = new URL(request.url).pathname;
    const writer = path === WRITER_RPC_PATH;
    const notes = path === NOTES_RPC_PATH;
    if (!writer && !notes && path !== PUBLIC_RPC_PATH)
        return Promise.resolve(new Response(null, { status: 404 }));
    const headers = new Headers({ "cache-control": "no-store" });
    const origin = request.headers.get("origin");
    if (!writer && (!notes || (origin !== null && originAllowed(origin, config.websiteOrigin)))) {
        headers.set("access-control-allow-origin", notes ? (origin ?? "") : "*");
        headers.set("access-control-allow-methods", "POST, OPTIONS");
        headers.set("access-control-allow-headers", "content-type");
        if (notes) headers.set("vary", "Origin");
    }
    const deny = (status: number) => new Response(null, { status, headers });
    if (writer && !authorized(request, config.writerToken)) return Promise.resolve(deny(401));
    if (notes && (origin === null || !originAllowed(origin, config.websiteOrigin)))
        return Promise.resolve(deny(403));
    if (request.method === "OPTIONS" && !writer) return Promise.resolve(deny(204));
    if (request.method !== "POST") return Promise.resolve(deny(405));
    return HttpEffect.toWebHandler(
        Effect.gen(function* () {
            const body = yield* readRpcBody(
                request,
                writer ? 32 * 1024 * 1024 : notes ? 8 * 1024 : 16 * 1024,
            );
            if (body === null) {
                return HttpServerResponse.empty({ status: 413, headers });
            }
            const buffered = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body,
                signal: request.signal,
            });
            const response = yield* rpcHttpApp(
                request,
                domains,
                config,
                writer,
                notes,
                origin,
            ).pipe(
                Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(buffered),
                ),
            );
            return HttpServerResponse.setHeaders(response, headers);
        }),
    )(request);
}
