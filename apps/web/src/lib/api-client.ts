import { SiteContent } from "@artisann-port/portfolio-domain/content";
import { Weather } from "@artisann-port/presence/api";
import { GithubSnapshot } from "@artisann-port/presence/github-schema";
import { NoteSubmissionAccepted, type NoteSubmission } from "@artisann-port/presence/notes";
import {
    collectPhotos,
    PhotoPage,
    type Photo,
    type PhotoTag,
} from "@artisann-port/presence/photos";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export class ApiError extends Schema.TaggedError<ApiError>()("PortfolioApiError", {
    operation: Schema.String,
}) {}

export class PortfolioHttp extends Context.Service<
    PortfolioHttp,
    {
        readonly content: Effect.Effect<SiteContent, ApiError>;
        readonly photos: (tag: PhotoTag) => Effect.Effect<readonly Photo[], ApiError>;
        readonly github: Effect.Effect<GithubSnapshot, ApiError>;
        readonly weather: Effect.Effect<Weather, ApiError>;
        readonly submitNote: (
            input: NoteSubmission,
        ) => Effect.Effect<NoteSubmissionAccepted, ApiError>;
    }
>()("PortfolioHttp") {}

export const portfolioHttpLayer = (origin: string) =>
    Layer.effect(
        PortfolioHttp,
        Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const base = origin.replace(/\/+$/u, "");
            const read = <A, I>(schema: Schema.Codec<A, I, never, never>, path: string) =>
                client.get(`${base}${path}`).pipe(
                    Effect.flatMap(HttpClientResponse.filterStatusOk),
                    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
                    Effect.timeout("10 seconds"),
                    Effect.mapError(() => new ApiError({ operation: path })),
                );
            return PortfolioHttp.of({
                content: read(SiteContent, "/api/content"),
                github: read(GithubSnapshot, "/api/github"),
                weather: read(Weather, "/api/weather"),
                photos: Effect.fn("PortfolioHttp.photos")(function* (tag: PhotoTag) {
                    return yield* collectPhotos(tag, (cursor) => {
                        const params = new URLSearchParams({ tag });
                        if (cursor !== undefined) params.set("cursor", cursor);
                        return read(PhotoPage, `/api/photos?${params}`);
                    }).pipe(Effect.mapError(() => new ApiError({ operation: "photos" })));
                }),
                submitNote: Effect.fn("PortfolioHttp.submitNote")((input: NoteSubmission) =>
                    HttpClientRequest.post(`${base}/api/notes`).pipe(
                        HttpClientRequest.bodyJson(input),
                        Effect.flatMap(client.execute),
                        Effect.flatMap(HttpClientResponse.filterStatusOk),
                        Effect.flatMap(HttpClientResponse.schemaBodyJson(NoteSubmissionAccepted)),
                        Effect.timeout("15 seconds"),
                        Effect.mapError(() => new ApiError({ operation: "notes" })),
                    ),
                ),
            });
        }),
    );
