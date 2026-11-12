import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
    CommentResult,
    DeckPayload,
    LeaderboardPayload,
    LikeResult,
    PhotoDetail,
    isServerFailureMessage,
    type CommentInput,
    type LikeInput,
} from "./contracts.ts";

export class CatsApiFailure extends Schema.TaggedError<CatsApiFailure>()("CatsApiFailure", {
    status: Schema.Number,
    message: Schema.String,
}) {}

const FailureBody = Schema.Struct({ message: Schema.String });

export interface CatsHttpOptions {
    readonly origin: string;
    readonly cookie?: string;
    readonly onSetCookie?: (cookie: string) => void;
}

export const makeCatsHttp = (options: CatsHttpOptions) => {
    const request = <A>(
        path: string,
        schema: Schema.Codec<A, unknown, never, never>,
        body?: LikeInput | CommentInput,
    ) =>
        Effect.gen(function* () {
            const origin = options.origin === "" ? globalThis.location.origin : options.origin;
            const headers = options.cookie === undefined ? {} : { cookie: options.cookie };
            const base =
                body === undefined
                    ? HttpClientRequest.get(`${origin}${path}`)
                    : yield* HttpClientRequest.bodyJson(
                          HttpClientRequest.post(`${origin}${path}`),
                          body,
                      );
            const response = yield* HttpClient.execute(HttpClientRequest.setHeaders(base, headers));
            const cookie = response.headers["set-cookie"];
            if (cookie !== undefined) options.onSetCookie?.(cookie);
            if (response.status < 200 || response.status >= 300) {
                const failure = yield* HttpClientResponse.schemaBodyJson(FailureBody)(
                    response,
                ).pipe(Effect.option);
                const message =
                    failure._tag === "Some" && isServerFailureMessage(failure.value.message)
                        ? failure.value.message
                        : response.status === 429
                          ? "Rate limited"
                          : "Request unavailable";
                return yield* Effect.fail(new CatsApiFailure({ status: response.status, message }));
            }
            return yield* HttpClientResponse.schemaBodyJson(schema)(response);
        }).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError((error) =>
                error instanceof CatsApiFailure
                    ? error
                    : new CatsApiFailure({ status: 0, message: "Request unavailable" }),
            ),
        );

    return {
        deck: Effect.fn("CatsHttp.deck")(() => request("/api/deck", DeckPayload)),
        top: Effect.fn("CatsHttp.top")(() => request("/api/top", LeaderboardPayload)),
        photo: Effect.fn("CatsHttp.photo")((id: string) =>
            request(`/api/photo/${encodeURIComponent(id)}`, PhotoDetail),
        ),
        heart: Effect.fn("CatsHttp.heart")((input: LikeInput) =>
            request("/api/hearts", LikeResult, input),
        ),
        comment: Effect.fn("CatsHttp.comment")((input: CommentInput) =>
            request("/api/comments", CommentResult, input),
        ),
    };
};

export const catsHttp = makeCatsHttp({ origin: "" });
