import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { Photo } from "@artisann-port/cats-domain/photo.aggregate";
import { PhotoIndex } from "@artisann-port/cats-domain/photo-index.projection";
import { Cats } from "@artisann-port/cats-domain/cats.model";
import { CatsApi } from "@artisann-port/cats-domain/cats.api";
import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { CatsWorkerEnv } from "../env.ts";
import { Likes } from "./database.ts";
import { handleCatsRequest, jsonResponse } from "./http.ts";
import { authorityMode } from "./hearts-service.ts";
import { makeServerLayer } from "./layer.ts";
import { PhotoIndexLive } from "./photo-index.ts";
import { resolveVisitor } from "./visitor.ts";

const CatsLive = Cats.layer(PhotoIndexLive).pipe(
    Layer.provide(DomainCloudflare.layerDurableObjects()),
);

export default class CatsBackend extends Cloudflare.Worker<CatsBackend>()(
    "CatsBackend",
    Effect.gen(function* () {
        const likes = yield* Likes;
        return {
            main: import.meta.url,
            env: {
                LIKES: likes,
                IMAGES: Cloudflare.Images.Images("IMAGES"),
                CONTENT_WRITER_TOKEN: Config.Redacted("CONTENT_WRITER_TOKEN"),
                ASSETS_HOST: Config.NonEmptyString("ASSETS_HOST").pipe(
                    Config.withDefault(DEFAULT_ASSETS_HOST),
                ),
                PORTFOLIO_ORIGIN: Config.NonEmptyString("PORTFOLIO_ORIGIN").pipe(
                    Config.withDefault("https://presence.artisann.dev"),
                ),
            },
        };
    }),
    Effect.gen(function* () {
        const publicApi = yield* CatsApi;
        const photo = yield* Photo;
        const projection = yield* PhotoIndex.Progress;
        return {
            fetch: Effect.gen(function* () {
                const current = yield* HttpServerRequest.HttpServerRequest;
                const request = yield* HttpServerRequest.toWeb(current);
                const native = yield* Cloudflare.WorkerEnvironment;
                // SAFETY: CatsBackend's env plus the stack's native bindings define this exact surface.
                const env = native as CatsWorkerEnv;
                const path = new URL(request.url).pathname;
                if (path === "/api/domain" || path.startsWith("/api/domain/")) {
                    const mode = yield* authorityMode(env.LIKES);
                    const response =
                        mode === "domain"
                            ? yield* publicApi.fetch
                            : HttpServerResponse.fromWeb(
                                  jsonResponse({ message: "Hearts unavailable" }, 503),
                              );
                    const visitor = resolveVisitor(request);
                    return visitor.cookie === null
                        ? response
                        : HttpServerResponse.setHeader(response, "set-cookie", visitor.cookie);
                }
                const response = yield* handleCatsRequest(
                    request,
                    Redacted.make(env.CONTENT_WRITER_TOKEN),
                ).pipe(Effect.provide(makeServerLayer(env)));
                return HttpServerResponse.fromWeb(response);
            }).pipe(
                Effect.provideService(Photo, photo),
                Effect.provideService(PhotoIndex.Progress, projection),
                Effect.catchCause(() =>
                    Effect.succeed(
                        HttpServerResponse.fromWeb(
                            jsonResponse({ message: "Deck unavailable" }, 503),
                        ),
                    ),
                ),
            ),
        };
    }).pipe(Effect.provide(CatsLive)),
) {}
