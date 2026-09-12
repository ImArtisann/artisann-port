/**
 * The visitor's two write actions. The edge rate limiter runs first per client,
 * the photo key must be a managed photo that actually exists in the bucket,
 * and the count that comes back is the authoritative one from D1. A repeat
 * heart from the same visitor never raises the count, and a comment is trimmed,
 * length-checked, and content-filtered before it is stored.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MAX_COMMENT_LENGTH, SITE_PHOTO_TAG, type CommentResult } from "../contracts.ts";
import type { VisitorRateLimitBinding } from "../env.ts";
import { spamProblem } from "./comment-filter.ts";
import { PhotosBinding } from "./deck-service.ts";
import { HeartsService } from "./hearts-service.ts";
import { ModerationService } from "./moderation-service.ts";
import { parseManagedKey } from "./photo-id.ts";

export class HeartError extends Schema.TaggedError<HeartError>()("Heart.Error", {
    reason: Schema.Literals([
        "InvalidKey",
        "NotFound",
        "RateLimited",
        "Unavailable",
        "EmptyComment",
        "CommentTooLong",
        "Filtered",
    ]),
}) {}

/** Cloudflare's simple edge rate limiter (60 requests / 60 seconds per key). */
export class RateLimitBinding extends Context.Service<RateLimitBinding, VisitorRateLimitBinding>()(
    "Heart.RateLimit",
) {}

/** The authoritative count after one heart landed. */
export interface HeartOutcome {
    readonly key: string;
    readonly likes: number;
    readonly hearted: true;
}

export interface HeartOperations {
    /** Land one heart on one managed cat photo; a repeat is a no-op. */
    readonly heart: (
        key: string,
        visitorId: string,
        clientKey: string,
    ) => Effect.Effect<HeartOutcome, HeartError>;
    /** Store one comment on one managed cat photo. */
    readonly comment: (
        key: string,
        visitorId: string,
        clientKey: string,
        body: string,
    ) => Effect.Effect<CommentResult, HeartError>;
}

export class HeartService extends Context.Service<HeartService, HeartOperations>()(
    "Heart.Service",
) {}

/** Native R2 + D1 heart and comment actions. Acquisition captures bindings, no I/O. */
export const HeartLive = Layer.effect(
    HeartService,
    Effect.gen(function* () {
        const photos = yield* PhotosBinding;
        const hearts = yield* HeartsService;
        const rateLimit = yield* RateLimitBinding;
        const moderation = yield* ModerationService;

        /** Both actions start here: a refused client never reaches storage. */
        const enforceRateLimit = Effect.fn("Heart.rateLimit")(function* (clientKey: string) {
            const verdict = yield* Effect.tryPromise({
                try: () => rateLimit.limit({ key: clientKey }),
                catch: () => new HeartError({ reason: "Unavailable" }),
            });
            if (!verdict.success) return yield* new HeartError({ reason: "RateLimited" });
        });

        /** The key must be a managed cat photo, and the object must exist. */
        const requireLiveCatPhoto = Effect.fn("Heart.requirePhoto")(function* (key: string) {
            const managed = parseManagedKey(key);
            if (managed === null || managed.tag !== SITE_PHOTO_TAG) {
                return yield* new HeartError({ reason: "InvalidKey" });
            }

            const object = yield* Effect.tryPromise({
                try: () => photos.head(key),
                catch: () => new HeartError({ reason: "Unavailable" }),
            });
            if (object === null) return yield* new HeartError({ reason: "NotFound" });
        });

        const heart = Effect.fn("Heart.heart")(function* (
            key: string,
            visitorId: string,
            clientKey: string,
        ) {
            yield* enforceRateLimit(clientKey);
            yield* requireLiveCatPhoto(key);

            const count = yield* hearts
                .heart(key, visitorId)
                .pipe(Effect.mapError(() => new HeartError({ reason: "Unavailable" })));

            const outcome: HeartOutcome = { key, likes: count, hearted: true };
            return outcome;
        });

        const comment = Effect.fn("Heart.comment")(function* (
            key: string,
            visitorId: string,
            clientKey: string,
            body: string,
        ) {
            yield* enforceRateLimit(clientKey);

            const trimmed = body.trim();
            if (trimmed.length === 0) return yield* new HeartError({ reason: "EmptyComment" });
            if (trimmed.length > MAX_COMMENT_LENGTH) {
                return yield* new HeartError({ reason: "CommentTooLong" });
            }

            if (spamProblem(trimmed) !== null) {
                return yield* new HeartError({ reason: "Filtered" });
            }

            const profane = yield* moderation
                .isProfane(trimmed)
                .pipe(Effect.mapError(() => new HeartError({ reason: "Unavailable" })));
            if (profane) return yield* new HeartError({ reason: "Filtered" });

            yield* requireLiveCatPhoto(key);

            const created = yield* hearts
                .addComment(key, visitorId, trimmed)
                .pipe(Effect.mapError(() => new HeartError({ reason: "Unavailable" })));

            return { comment: created } satisfies CommentResult;
        });

        return { heart, comment };
    }),
);
