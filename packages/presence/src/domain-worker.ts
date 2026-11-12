import * as Cloudflare from "@alchemy.run/cloudflare";
import { PortfolioApi } from "@artisann-port/portfolio-domain/portfolio.api";
import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Snapshots } from "./database.ts";
import { PortfolioLive } from "./portfolio-runtime.ts";
import { PortfolioEnvironment } from "./portfolio-bindings.ts";
import { PRESENCE_OBJECT_NAME } from "./presence-service.ts";
import { readRequestBody } from "./http-body.ts";
import { handlePortfolioHttp, errorResponse, publicCorsHeaders } from "./http-server.ts";
import { ApiUnavailable } from "./api-errors.ts";
import { CmsContentService } from "./cms-service.ts";
import { PortfolioMigration } from "./content-migration-service.ts";
import { GithubService } from "./github.ts";
import { NotesService } from "./notes-service.ts";
import { PhotosService } from "./photos-service.ts";
import { PresenceService } from "./presence-service.ts";
import { WeatherService } from "./weather-service.ts";

export default class PortfolioBackend extends Cloudflare.Worker<PortfolioBackend>()(
    "PortfolioBackend",
    Effect.gen(function* () {
        const snapshots = yield* Snapshots;
        return {
            main: import.meta.url,
            compatibility: { flags: ["nodejs_compat"] },
            env: {
                PRESENCE_KV: snapshots,
                CONTENT_WRITER_TOKEN: Config.Redacted("CONTENT_WRITER_TOKEN"),
                ASSETS_HOST: Config.NonEmptyString("ASSETS_HOST").pipe(
                    Config.withDefault(DEFAULT_ASSETS_HOST),
                ),
                DISCORD_NOTES_WEBHOOK_URL: Config.Redacted("DISCORD_NOTES_WEBHOOK_URL"),
                TURNSTILE_SECRET_KEY: Config.Redacted("TURNSTILE_SECRET_KEY"),
                DISCORD_NOTES_CHANNEL_ID: Config.NonEmptyString("DISCORD_NOTES_CHANNEL_ID"),
                WEBSITE_ORIGIN: Config.NonEmptyString("WEBSITE_ORIGIN").pipe(
                    Config.withDefault("https://www.artisann.dev"),
                ),
            },
        };
    }),
    Effect.gen(function* () {
        const api = yield* PortfolioApi;
        const env = yield* PortfolioEnvironment;
        const httpServices = Context.make(PortfolioEnvironment, env).pipe(
            Context.add(CmsContentService, yield* CmsContentService),
            Context.add(PortfolioMigration, yield* PortfolioMigration),
            Context.add(GithubService, yield* GithubService),
            Context.add(HttpClient.HttpClient, yield* HttpClient.HttpClient),
            Context.add(NotesService, yield* NotesService),
            Context.add(PhotosService, yield* PhotosService),
            Context.add(PresenceService, yield* PresenceService),
            Context.add(WeatherService, yield* WeatherService),
        );
        return {
            fetch: Effect.gen(function* () {
                const current = yield* HttpServerRequest.HttpServerRequest;
                const request = yield* HttpServerRequest.toWeb(current).pipe(
                    Effect.mapError((reason) => new HttpServerError.HttpServerError({ reason })),
                );
                const path = new URL(request.url).pathname;
                if (path === "/presence") {
                    if (request.method !== "GET") return HttpServerResponse.empty({ status: 405 });
                    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
                        return HttpServerResponse.empty({ status: 426 });
                    const response = yield* Effect.tryPromise({
                        try: () =>
                            env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)).fetch(
                                request,
                            ),
                        catch: () => new ApiUnavailable({ operation: "presence.socket" }),
                    }).pipe(
                        Effect.match({
                            onFailure: () => new Response(null, { status: 503 }),
                            onSuccess: (response) => response,
                        }),
                    );
                    return HttpServerResponse.setBody(
                        HttpServerResponse.empty({ status: response.status }),
                        HttpBody.raw(response),
                    );
                }
                if (path === "/api/domain" || path.startsWith("/api/domain/")) {
                    if (request.method === "OPTIONS")
                        return HttpServerResponse.empty({
                            status: 204,
                            headers: publicCorsHeaders,
                        });
                    if (request.method !== "POST" && request.method !== "GET")
                        return HttpServerResponse.empty({
                            status: 405,
                            headers: publicCorsHeaders,
                        });
                    if (request.method === "POST") {
                        const result = yield* Effect.result(readRequestBody(request, 16 * 1024));
                        if (Result.isFailure(result))
                            return HttpServerResponse.fromWeb(errorResponse(result.failure));
                        const buffered = new Request(request.url, {
                            method: request.method,
                            headers: request.headers,
                            body: result.success,
                            signal: request.signal,
                        });
                        return yield* api.fetch.pipe(
                            Effect.provideService(
                                HttpServerRequest.HttpServerRequest,
                                HttpServerRequest.fromWeb(buffered),
                            ),
                            Effect.map((response) =>
                                HttpServerResponse.setHeaders(response, publicCorsHeaders),
                            ),
                        );
                    }
                    return yield* api.fetch.pipe(
                        Effect.map((response) =>
                            HttpServerResponse.setHeaders(response, publicCorsHeaders),
                        ),
                    );
                }
                return HttpServerResponse.fromWeb(
                    yield* handlePortfolioHttp(request).pipe(Effect.provideContext(httpServices)),
                );
            }),
        };
    }).pipe(Effect.provide(PortfolioLive)),
) {}
