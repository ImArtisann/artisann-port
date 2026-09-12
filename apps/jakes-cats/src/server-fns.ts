/**
 * This site's server functions: the deck, the leaderboard, one photo's page,
 * a heart, and a comment. Every one resolves the anonymous visitor from the
 * request cookie, reads storage fresh, and rejects with one fixed-message
 * `ServerFailure` so no cause, binding, or SQL ever reaches the browser. A
 * photo page whose id names nothing live is a router `notFound()`, thrown
 * outside the Effect.
 */
import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
    CommentInput,
    LikeInput,
    PhotoInput,
    SERVER_FAILURE_MESSAGES,
    type LikeResult,
    type PhotoDetail,
    type ServerFailureMessage,
} from "./contracts.ts";
import { DeckService } from "./server/deck-service.ts";
import { HeartError, HeartService } from "./server/heart-service.ts";
import { runServer } from "./server/layer.ts";
import { clientKey, currentVisitor } from "./server/visitor.ts";

/** The only error shape a server function rejects with; `message` is a fixed phrase. */
export class ServerFailure extends Schema.TaggedError<ServerFailure>()("Jakes.ServerFailure", {
    message: Schema.String,
}) {}

/**
 * The site's failure copy, unpacked so every table below draws from the one
 * shared allowlist the client also trusts.
 */
const {
    commentNotAllowed,
    commentTooLong,
    commentsUnavailable,
    deckUnavailable,
    emptyComment,
    heartsUnavailable,
    leaderboardUnavailable,
    notAllowed,
    photoUnavailable,
    rateLimited,
    unknownPhoto,
} = SERVER_FAILURE_MESSAGES;

/** One message per heart failure class; nothing else leaves the server. */
const HEART_FAILURE_MESSAGES = {
    InvalidKey: unknownPhoto,
    NotFound: unknownPhoto,
    RateLimited: rateLimited,
    Unavailable: heartsUnavailable,
    EmptyComment: emptyComment,
    CommentTooLong: commentTooLong,
    Filtered: notAllowed,
} satisfies Record<HeartError["reason"], ServerFailureMessage>;

/** The comment action's table: the same classes, its own storage message. */
const COMMENT_FAILURE_MESSAGES = {
    ...HEART_FAILURE_MESSAGES,
    Unavailable: commentsUnavailable,
    Filtered: commentNotAllowed,
} satisfies Record<HeartError["reason"], ServerFailureMessage>;

/** What one photo page request produced, so `notFound()` is thrown outside the Effect. */
type PhotoOutcome =
    | { readonly _tag: "Found"; readonly detail: PhotoDetail }
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Failed" };

/** A freshly shuffled deck of every managed cat photo, with this visitor's hearts. */
export const getDeck = createServerFn({ method: "GET" }).handler(() =>
    runServer(
        Effect.gen(function* () {
            const deck = yield* DeckService;
            const visitor = yield* currentVisitor;
            return yield* deck.shuffled(visitor);
        }).pipe(Effect.mapError(() => new ServerFailure({ message: deckUnavailable }))),
    ),
);

/** The most-hearted live cat photos, best first. */
export const getLeaderboard = createServerFn({ method: "GET" }).handler(() =>
    runServer(
        Effect.gen(function* () {
            const deck = yield* DeckService;
            const visitor = yield* currentVisitor;
            return yield* deck.leaderboard(visitor);
        }).pipe(Effect.mapError(() => new ServerFailure({ message: leaderboardUnavailable }))),
    ),
);

/** One photo's page: the photo itself and its newest comments, this visitor's marked. */
export const getPhoto = createServerFn({ method: "GET" })
    .validator((input) => Schema.decodeUnknownSync(PhotoInput)(input))
    .handler(({ data }) =>
        runServer(
            Effect.gen(function* () {
                const deck = yield* DeckService;
                const visitor = yield* currentVisitor;
                return yield* deck.detail(data.id, visitor);
            }).pipe(
                // Folded here because `notFound()` is the router's signal, not
                // an Effect failure: it is thrown from the handler below.
                Effect.match({
                    onSuccess: (detail): PhotoOutcome => ({ _tag: "Found", detail }),
                    onFailure: (error): PhotoOutcome =>
                        error._tag === "Deck.PhotoNotFound"
                            ? { _tag: "Missing" }
                            : { _tag: "Failed" },
                }),
            ),
        ).then((outcome) => {
            if (outcome._tag === "Missing") throw notFound();
            if (outcome._tag === "Failed") {
                throw new ServerFailure({ message: photoUnavailable });
            }
            return outcome.detail;
        }),
    );

/** One heart on one managed cat photo; a repeat from the same visitor is a no-op. */
export const likePhoto = createServerFn({ method: "POST" })
    .validator((input) => Schema.decodeUnknownSync(LikeInput)(input))
    .handler(({ data }) =>
        runServer(
            Effect.gen(function* () {
                const hearts = yield* HeartService;
                const visitor = yield* currentVisitor;
                const outcome = yield* hearts.heart(data.key, visitor, clientKey());
                return outcome satisfies LikeResult;
            }).pipe(
                Effect.mapError(
                    (error) => new ServerFailure({ message: HEART_FAILURE_MESSAGES[error.reason] }),
                ),
            ),
        ),
    );

/** One comment on one managed cat photo, stored under this visitor's identity. */
export const addComment = createServerFn({ method: "POST" })
    .validator((input) => Schema.decodeUnknownSync(CommentInput)(input))
    .handler(({ data }) =>
        runServer(
            Effect.gen(function* () {
                const hearts = yield* HeartService;
                const visitor = yield* currentVisitor;
                return yield* hearts.comment(data.key, visitor, clientKey(), data.body);
            }).pipe(
                Effect.mapError(
                    (error) =>
                        new ServerFailure({ message: COMMENT_FAILURE_MESSAGES[error.reason] }),
                ),
            ),
        ),
    );
