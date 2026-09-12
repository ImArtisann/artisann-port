/**
 * Photo ids for uploads that arrive through this site. The portfolio only
 * lists keys matching `(life|cats)/<17-20 digits>.webp`, so an upload must mint
 * an id in that grammar. The layout is Discord's snowflake — milliseconds since
 * Discord's epoch, shifted left 22 bits, with a random tail — so ids minted
 * here sort alongside the ones the bot mints and are 19-20 digits today.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { PHOTO_TAGS, photoKey, type PhotoTag } from "@artisann-port/presence/photos";

/** Discord's epoch (2015-01-01T00:00:00Z), the origin the bot's ids use. */
const DISCORD_EPOCH_MS = 1420070400000;

/** Bits the snowflake reserves for the timestamp-and-sequence layout. */
const SNOWFLAKE_SHIFT = 22n;

/** Random tail width; masking keeps any integer input inside it. */
const ENTROPY_BITS = 12;
const ENTROPY_MASK = (1 << ENTROPY_BITS) - 1;

const MANAGED_PHOTO_SUFFIX = ".webp";

/**
 * The snowflake for one upload at `nowMs`. `entropy` is masked to its low 12
 * bits, so callers may pass any integer; timestamps before Discord's epoch
 * clamp to the epoch rather than going negative.
 */
export function syntheticPhotoId(nowMs: number, entropy: number): string {
    const elapsed = BigInt(Math.max(0, Math.trunc(nowMs - DISCORD_EPOCH_MS)));
    const tail = BigInt(Math.trunc(entropy) & ENTROPY_MASK);
    return ((elapsed << SNOWFLAKE_SHIFT) | tail).toString();
}

/** A fresh id for one upload, drawn from the live clock and Random. */
export const makePhotoId: Effect.Effect<string> = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const entropy = yield* Random.nextIntBetween(0, ENTROPY_MASK);
    return syntheticPhotoId(nowMs, entropy);
});

/** The two halves of a managed photo key. */
export interface ManagedPhotoKey {
    readonly tag: PhotoTag;
    readonly id: string;
}

/**
 * The collection and id inside a managed photo key, or `null` when the key is
 * not one this site owns. The key is rebuilt through `photoKey`, so `life/…`,
 * short ids, and traversal attempts all fail rather than reaching storage.
 */
export function parseManagedKey(key: string): ManagedPhotoKey | null {
    for (const tag of PHOTO_TAGS) {
        const prefix = `${tag}/`;
        if (!key.startsWith(prefix) || !key.endsWith(MANAGED_PHOTO_SUFFIX)) continue;
        const id = key.slice(prefix.length, key.length - MANAGED_PHOTO_SUFFIX.length);
        if (photoKey(tag, id) === key) return { tag, id };
    }
    return null;
}
