/**
 * Browser-safe contracts shared by the deck, the leaderboard, the photo page,
 * the server functions, and the upload API. No env reads, no Worker imports:
 * this module is bundled into the client.
 */
import * as Schema from "effect/Schema";
import { PhotoTag, photoKey } from "@artisann-port/presence/photos";

/** The photo collection this site serves. */
export const SITE_PHOTO_TAG: PhotoTag = "cats";

/** Discord-style snowflake: the id part of a managed key. */
export const PhotoId = Schema.String.check(Schema.isPattern(/^[0-9]{17,20}$/u));

export type PhotoId = typeof PhotoId.Type;

/** The snowflake inside a managed `cats/<id>.webp` key, or `null`. */
export function photoIdFromKey(key: string): string | null {
    const prefix = `${SITE_PHOTO_TAG}/`;
    if (!key.startsWith(prefix) || !key.endsWith(".webp")) return null;
    const id = key.slice(prefix.length, key.length - ".webp".length);
    return photoKey(SITE_PHOTO_TAG, id) === key ? id : null;
}

/** Site path of one photo's page, or `null` for an unmanaged key. */
export function photoPagePath(key: string): string | null {
    const id = photoIdFromKey(key);
    return id === null ? null : `/photos/${id}`;
}

/** One card: a managed R2 photo, its heart count, and whether this visitor hearted it. */
export const DeckPhoto = Schema.Struct({
    /** Managed R2 key, e.g. `cats/123456789012345678.webp`. */
    key: Schema.String,
    /** Public image URL on the assets host. */
    url: Schema.String,
    likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    hearted: Schema.Boolean,
});

export type DeckPhoto = typeof DeckPhoto.Type;

/** A freshly shuffled deck. Empty when the collection has no photos. */
export const DeckPayload = Schema.Struct({
    photos: Schema.Array(DeckPhoto),
});

export type DeckPayload = typeof DeckPayload.Type;

/** Input of the heart action. */
export const LikeInput = Schema.Struct({
    key: Schema.String.check(Schema.isMaxLength(64)),
});

export type LikeInput = typeof LikeInput.Type;

/** The authoritative count after the visitor's heart is recorded (idempotent). */
export const LikeResult = Schema.Struct({
    key: Schema.String,
    likes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    hearted: Schema.Literal(true),
});

export type LikeResult = typeof LikeResult.Type;

/** How many photos the leaderboard shows. */
export const LEADERBOARD_SIZE = 20;

/** One leaderboard row; `rank` is 1-based. */
export const LeaderboardEntry = Schema.Struct({
    rank: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    photo: DeckPhoto,
});

export type LeaderboardEntry = typeof LeaderboardEntry.Type;

export const LeaderboardPayload = Schema.Struct({
    entries: Schema.Array(LeaderboardEntry),
});

export type LeaderboardPayload = typeof LeaderboardPayload.Type;

/** Longest comment body, after trimming. */
export const MAX_COMMENT_LENGTH = 280;

/** How many comments a photo page loads, newest first. */
export const MAX_COMMENTS_PER_PHOTO = 100;

export const PhotoComment = Schema.Struct({
    id: Schema.Int,
    body: Schema.String,
    /** ISO timestamp. */
    createdAt: Schema.String,
    /** True when this visitor wrote it. */
    mine: Schema.Boolean,
});

export type PhotoComment = typeof PhotoComment.Type;

/** Input of the photo page loader. */
export const PhotoInput = Schema.Struct({ id: PhotoId });

export type PhotoInput = typeof PhotoInput.Type;

export const PhotoDetail = Schema.Struct({
    photo: DeckPhoto,
    comments: Schema.Array(PhotoComment),
});

export type PhotoDetail = typeof PhotoDetail.Type;

export const CommentInput = Schema.Struct({
    key: Schema.String.check(Schema.isMaxLength(64)),
    body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMENT_LENGTH)),
});

export type CommentInput = typeof CommentInput.Type;

export const CommentResult = Schema.Struct({
    comment: PhotoComment,
});

export type CommentResult = typeof CommentResult.Type;

/** JSON body returned by `POST /api/photos` on success (HTTP 201). */
export const UploadResult = Schema.Struct({
    key: Schema.String,
    url: Schema.String,
    tag: PhotoTag,
    likes: Schema.Int,
});

export type UploadResult = typeof UploadResult.Type;

/** Path of the secret-gated upload route. */
export const UPLOAD_API_PATH = "/api/photos";

/** Largest request body the upload route reads before refusing. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Longest edge of a stored photo; larger uploads are scaled down, never up. */
export const MAX_PHOTO_EDGE_PX = 1600;
