/**
 * The deck, the leaderboard, and one photo's page. Every photo comes from the
 * shared R2 bucket's managed keys, so a deleted (or never uploaded) object
 * never ranks and never gets a page; heart counts and comments come from D1,
 * and the deck is shuffled fresh on every read so two visitors — and two
 * reloads — never see the same order.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { collectPhotos, photoKey, photoUrl, readPhotos } from "@artisann-port/presence/photos";
import {
    LEADERBOARD_SIZE,
    MAX_COMMENTS_PER_PHOTO,
    SITE_PHOTO_TAG,
    type DeckPayload,
    type DeckPhoto,
    type LeaderboardEntry,
    type LeaderboardPayload,
    type PhotoDetail,
} from "../contracts.ts";
import type { PhotosR2MutationBinding } from "../env.ts";
import { HeartsService } from "./hearts-service.ts";

export class DeckError extends Schema.TaggedError<DeckError>()("Deck.Error", {
    operation: Schema.Literals(["deck.read", "leaderboard.read", "photo.read"]),
}) {}

/** The requested id names no managed cat photo present in the bucket. */
export class PhotoNotFound extends Schema.TaggedError<PhotoNotFound>()("Deck.PhotoNotFound", {
    id: Schema.String,
}) {}

/** The assets bucket binding (list for photos, put/head for uploads). */
export class PhotosBinding extends Context.Service<PhotosBinding, PhotosR2MutationBinding>()(
    "Photos.Binding",
) {}

/** The public host photo URLs are built from. */
export interface PhotosConfigValue {
    readonly assetsHost: string;
}

export class PhotosConfig extends Context.Service<PhotosConfig, PhotosConfigValue>()(
    "Photos.Config",
) {}

export interface DeckOperations {
    /** A freshly shuffled deck, read on every call, with this visitor's hearts. */
    readonly shuffled: (visitorId: string) => Effect.Effect<DeckPayload, DeckError>;
    /** The most-hearted photos present in the bucket, best first. */
    readonly leaderboard: (visitorId: string) => Effect.Effect<LeaderboardPayload, DeckError>;
    /** One photo's page, or `PhotoNotFound` when it is not a live cat photo. */
    readonly detail: (
        id: string,
        visitorId: string,
    ) => Effect.Effect<PhotoDetail, DeckError | PhotoNotFound>;
}

export class DeckService extends Context.Service<DeckService, DeckOperations>()("Deck.Service") {}

/** Fisher–Yates over Effect's Random, so the order is uniform and reproducible. */
const shuffle = Effect.fn("Deck.shuffle")(function* <A>(items: ReadonlyArray<A>) {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const target = yield* Random.nextIntBetween(0, index);
        const held = shuffled[index];
        const displaced = shuffled[target];
        if (held === undefined || displaced === undefined) continue;
        shuffled[index] = displaced;
        shuffled[target] = held;
    }
    return shuffled;
});

/** Native R2 + D1-backed deck. Acquisition captures bindings and config values. */
export const DeckLive = Layer.effect(
    DeckService,
    Effect.gen(function* () {
        const binding = yield* PhotosBinding;
        const config = yield* PhotosConfig;
        const hearts = yield* HeartsService;

        /** Every managed photo of this collection, straight from the bucket. */
        const listManaged = (operation: DeckError["operation"]) =>
            collectPhotos(SITE_PHOTO_TAG, (cursor) =>
                readPhotos(binding, SITE_PHOTO_TAG, cursor, config.assetsHost),
            ).pipe(Effect.mapError(() => new DeckError({ operation })));

        const shuffled = Effect.fn("Deck.shuffled")(function* (visitorId: string) {
            const photos = yield* listManaged("deck.read");
            const counts = yield* hearts
                .countsFor(SITE_PHOTO_TAG)
                .pipe(Effect.mapError(() => new DeckError({ operation: "deck.read" })));
            const hearted = yield* hearts
                .heartedBy(visitorId)
                .pipe(Effect.mapError(() => new DeckError({ operation: "deck.read" })));

            const deck: DeckPhoto[] = photos.map((photo) => ({
                key: photo.key,
                url: photo.url,
                likes: counts.get(photo.key) ?? 0,
                hearted: hearted.has(photo.key),
            }));

            return { photos: yield* shuffle(deck) } satisfies DeckPayload;
        });

        const leaderboard = Effect.fn("Deck.leaderboard")(function* (visitorId: string) {
            const ranked = yield* hearts
                .top(SITE_PHOTO_TAG, LEADERBOARD_SIZE)
                .pipe(Effect.mapError(() => new DeckError({ operation: "leaderboard.read" })));
            const photos = yield* listManaged("leaderboard.read");
            const hearted = yield* hearts
                .heartedBy(visitorId)
                .pipe(Effect.mapError(() => new DeckError({ operation: "leaderboard.read" })));

            const livePhotos = new Map<string, (typeof photos)[number]>();
            for (const photo of photos) livePhotos.set(photo.key, photo);

            // A photo deleted from the bucket drops out, so the ranks below it
            // close up instead of leaving a gap.
            const entries: LeaderboardEntry[] = [];
            for (const tally of ranked) {
                const photo = livePhotos.get(tally.key);
                if (photo === undefined) continue;
                entries.push({
                    rank: entries.length + 1,
                    photo: {
                        key: photo.key,
                        url: photo.url,
                        likes: tally.likes,
                        hearted: hearted.has(photo.key),
                    },
                });
            }

            return { entries } satisfies LeaderboardPayload;
        });

        const detail = Effect.fn("Deck.detail")(function* (id: string, visitorId: string) {
            const key = photoKey(SITE_PHOTO_TAG, id);
            if (key === null) return yield* new PhotoNotFound({ id });

            const object = yield* Effect.tryPromise({
                try: () => binding.head(key),
                catch: () => new DeckError({ operation: "photo.read" }),
            });
            if (object === null) return yield* new PhotoNotFound({ id });

            const url = photoUrl(key, config.assetsHost);
            if (url === null) return yield* new DeckError({ operation: "photo.read" });

            const counts = yield* hearts
                .countsFor(SITE_PHOTO_TAG)
                .pipe(Effect.mapError(() => new DeckError({ operation: "photo.read" })));
            const hearted = yield* hearts
                .heartedBy(visitorId)
                .pipe(Effect.mapError(() => new DeckError({ operation: "photo.read" })));
            const comments = yield* hearts
                .commentsFor(key, MAX_COMMENTS_PER_PHOTO, visitorId)
                .pipe(Effect.mapError(() => new DeckError({ operation: "photo.read" })));

            return {
                photo: {
                    key,
                    url,
                    likes: counts.get(key) ?? 0,
                    hearted: hearted.has(key),
                },
                comments,
            } satisfies PhotoDetail;
        });

        return { shuffled, leaderboard, detail };
    }),
);
