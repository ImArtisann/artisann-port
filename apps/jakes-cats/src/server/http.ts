import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
    CommentInput,
    LikeInput,
    SERVER_FAILURE_MESSAGES,
    type ServerFailureMessage,
} from "../contracts.ts";
import { isAuthorized } from "./auth.ts";
import { capRequestBody } from "./body-limit.ts";
import { DeckService } from "./deck-service.ts";
import { HeartService, type HeartError } from "./heart-service.ts";
import { MigrationService } from "./migration-service.ts";
import { uploadRoute } from "./upload-route.ts";
import { clientKey, resolveVisitor } from "./visitor.ts";

export function jsonResponse(body: Schema.Json, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}
const failed = (message: ServerFailureMessage, status = 503) => jsonResponse({ message }, status);
const heartMessages = {
    InvalidKey: SERVER_FAILURE_MESSAGES.unknownPhoto,
    NotFound: SERVER_FAILURE_MESSAGES.unknownPhoto,
    RateLimited: SERVER_FAILURE_MESSAGES.rateLimited,
    Unavailable: SERVER_FAILURE_MESSAGES.heartsUnavailable,
    EmptyComment: SERVER_FAILURE_MESSAGES.emptyComment,
    CommentTooLong: SERVER_FAILURE_MESSAGES.commentTooLong,
    Filtered: SERVER_FAILURE_MESSAGES.notAllowed,
} satisfies Record<HeartError["reason"], ServerFailureMessage>;
const commentMessages = {
    ...heartMessages,
    Unavailable: SERVER_FAILURE_MESSAGES.commentsUnavailable,
    Filtered: SERVER_FAILURE_MESSAGES.commentNotAllowed,
};
function actionFailure(error: HeartError, comment: boolean): Response {
    const status =
        error.reason === "RateLimited"
            ? 429
            : error.reason === "NotFound" || error.reason === "InvalidKey"
              ? 404
              : error.reason === "Unavailable"
                ? 503
                : 400;
    return failed((comment ? commentMessages : heartMessages)[error.reason], status);
}
const MigrationInput = Schema.Struct({
    phase: Schema.Literals(["hearts", "comments", "changes"]),
    take: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
const MigrationExportInput = Schema.Struct({
    phase: Schema.Literals(["hearts", "comments", "changes"]),
    after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    take: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    through: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const handleCatsRequest = Effect.fn("Cats.http")(function* (
    request: Request,
    token: Redacted.Redacted<string>,
) {
    const visitor = resolveVisitor(request);
    const path = new URL(request.url).pathname;
    const response = yield* Effect.gen(function* () {
        if (path === "/api/photos") {
            if (request.method !== "POST")
                return new Response(
                    JSON.stringify({
                        error: { code: "method_not_allowed", message: "Upload with POST." },
                    }),
                    {
                        status: 405,
                        headers: {
                            allow: "POST",
                            "content-type": "application/json",
                            "cache-control": "no-store",
                        },
                    },
                );
            return yield* uploadRoute(request, token);
        }
        if (path.startsWith("/api/migration/")) {
            if (!isAuthorized(request, token))
                return jsonResponse(
                    {
                        error: {
                            code: "unauthorized",
                            message: "A valid bearer token is required.",
                        },
                    },
                    401,
                );
            const migration = yield* MigrationService;
            const operation = path.slice("/api/migration/".length);
            if (operation === "status" && request.method === "GET")
                return jsonResponse(yield* migration.status);
            if (request.method !== "POST")
                return jsonResponse({ error: { code: "method_not_allowed" } }, 405);
            if (operation === "prepare") return jsonResponse(yield* migration.prepare);
            if (operation === "fence") return jsonResponse(yield* migration.fence);
            if (operation === "handoff") return jsonResponse(yield* migration.handoff);
            if (operation === "abort") return jsonResponse(yield* migration.abort);
            if (operation === "import") {
                const input = yield* Effect.tryPromise({
                    try: () => capRequestBody(request, 4096).json(),
                    catch: () => "invalid" as const,
                }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(MigrationInput)),
                    Effect.mapError(() => "invalid" as const),
                );
                return jsonResponse(yield* migration.importPage(input.phase, input.take));
            }
            if (operation === "export") {
                const input = yield* Effect.tryPromise({
                    try: () => capRequestBody(request, 4096).json(),
                    catch: () => "invalid" as const,
                }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(MigrationExportInput)),
                    Effect.mapError(() => "invalid" as const),
                );
                return jsonResponse(
                    yield* migration.exportPage(
                        input.phase,
                        input.after,
                        input.take,
                        input.through,
                    ),
                );
            }
            return jsonResponse({ error: { code: "not_found" } }, 404);
        }
        const deck = yield* DeckService;
        if (path === "/api/deck" && request.method === "GET")
            return yield* deck.shuffled(visitor.id).pipe(
                Effect.match({
                    onSuccess: (payload) => jsonResponse(payload),
                    onFailure: () => failed(SERVER_FAILURE_MESSAGES.deckUnavailable),
                }),
            );
        if (path === "/api/top" && request.method === "GET")
            return yield* deck.leaderboard(visitor.id).pipe(
                Effect.match({
                    onSuccess: (payload) => jsonResponse(payload),
                    onFailure: () => failed(SERVER_FAILURE_MESSAGES.leaderboardUnavailable),
                }),
            );
        if (path.startsWith("/api/photo/") && request.method === "GET")
            return yield* deck.detail(path.slice("/api/photo/".length), visitor.id).pipe(
                Effect.match({
                    onSuccess: (payload) => jsonResponse(payload),
                    onFailure: (error) =>
                        failed(
                            error._tag === "Deck.PhotoNotFound"
                                ? SERVER_FAILURE_MESSAGES.unknownPhoto
                                : SERVER_FAILURE_MESSAGES.photoUnavailable,
                            error._tag === "Deck.PhotoNotFound" ? 404 : 503,
                        ),
                }),
            );
        if ((path === "/api/hearts" || path === "/api/comments") && request.method === "POST") {
            const comment = path === "/api/comments";
            const input = yield* Effect.tryPromise({
                try: () => capRequestBody(request, 4096).json(),
                catch: () => "invalid" as const,
            });
            const heart = yield* HeartService;
            if (comment) {
                const decoded = yield* Schema.decodeUnknownEffect(CommentInput)(input).pipe(
                    Effect.mapError(() => "invalid" as const),
                );
                return yield* heart
                    .comment(decoded.key, visitor.id, clientKey(request), decoded.body)
                    .pipe(
                        Effect.match({
                            onSuccess: (payload) => jsonResponse(payload),
                            onFailure: (error) => actionFailure(error, true),
                        }),
                    );
            }
            const decoded = yield* Schema.decodeUnknownEffect(LikeInput)(input).pipe(
                Effect.mapError(() => "invalid" as const),
            );
            return yield* heart.heart(decoded.key, visitor.id, clientKey(request)).pipe(
                Effect.match({
                    onSuccess: (payload) => jsonResponse(payload),
                    onFailure: (error) => actionFailure(error, false),
                }),
            );
        }
        return jsonResponse({ error: { code: "not_found" } }, 404);
    }).pipe(
        Effect.catch((error) =>
            Effect.succeed(
                error === "invalid"
                    ? failed(
                          path === "/api/comments"
                              ? SERVER_FAILURE_MESSAGES.commentNotAllowed
                              : SERVER_FAILURE_MESSAGES.notAllowed,
                          400,
                      )
                    : jsonResponse(
                          { error: { code: error.reason } },
                          error.reason === "Unavailable" ? 503 : 409,
                      ),
            ),
        ),
    );
    if (visitor.cookie !== null) response.headers.append("set-cookie", visitor.cookie);
    return response;
});
