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
    type LikeResult,
    type PhotoDetail,
} from "./contracts.ts";
import { DeckService } from "./server/deck-service.ts";
import { HeartError, HeartService } from "./server/heart-service.ts";
import { runServer } from "./server/layer.ts";
import { clientKey, currentVisitor } from "./server/visitor.ts";

/** The only error shape a server function rejects with; `message` is a fixed phrase. */
export class ServerFailure extends Schema.TaggedError<ServerFailure>()("Jakes.ServerFailure", {
    message: Schema.String,
}) {}

/** One message per heart failure class; nothing else leaves the server. */
const HEART_FAILURE_MESSAGES = {
    InvalidKey: "Unknown photo",
    NotFound: "Unknown photo",
    RateLimited: "Rate limited",
    Unavailable: "Hearts unavailable",
    EmptyComment: "Comment can't be empty",
    CommentTooLong: "Comment is too long",
    Filtered: "Not allowed",
} satisfies Record<HeartError["reason"], string>;

/** The comment action's table: the same classes, its own storage message. */
const COMMENT_FAILURE_MESSAGES = {
    ...HEART_FAILURE_MESSAGES,
    Unavailable: "Comments unavailable",
    Filtered: "That comment isn't allowed.",
} satisfies Record<HeartError["reason"], string>;

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
        }).pipe(Effect.mapError(() => new ServerFailure({ message: "Deck unavailable" }))),
    ),
);

/** The most-hearted live cat photos, best first. */
export const getLeaderboard = createServerFn({ method: "GET" }).handler(() =>
    runServer(
        Effect.gen(function* () {
            const deck = yield* DeckService;
            const visitor = yield* currentVisitor;
            return yield* deck.leaderboard(visitor);
        }).pipe(Effect.mapError(() => new ServerFailure({ message: "Leaderboard unavailable" }))),
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
                throw new ServerFailure({ message: "Photo unavailable" });
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
