/**
 * Upload ids must land inside the managed key grammar at any timestamp this
 * site can run at, and key parsing must refuse everything the gallery would
 * never list — including traversal attempts.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { photoKey } from "@artisann-port/presence/photos";
import { makePhotoId, parseManagedKey, syntheticPhotoId } from "../src/server/photo-id.ts";

/** Today's clock and 2100-01-01, the realistic span this site mints ids in. */
const TIMESTAMPS_MS = [1_787_000_000_000, 4_102_444_800_000];

/** Every entropy edge the 12-bit mask has to survive. */
const ENTROPIES = [0, 1, 2048, 4095, 4096, -1];

const MANAGED_KEY = "cats/123456789012345678.webp";

describe("syntheticPhotoId", () => {
    it("mints ids inside the managed key grammar at every timestamp", () => {
        for (const nowMs of TIMESTAMPS_MS) {
            for (const entropy of ENTROPIES) {
                const id = syntheticPhotoId(nowMs, entropy);
                expect(photoKey("cats", id)).toBe(`cats/${id}.webp`);
                expect(id.length).toBeLessThanOrEqual(20);
            }
        }
    });

    it("masks entropy to twelve bits", () => {
        const nowMs = TIMESTAMPS_MS[0] ?? 0;
        expect(syntheticPhotoId(nowMs, 4096)).toBe(syntheticPhotoId(nowMs, 0));
        expect(syntheticPhotoId(nowMs, -1)).toBe(syntheticPhotoId(nowMs, 4095));
        expect(syntheticPhotoId(nowMs, 7)).not.toBe(syntheticPhotoId(nowMs, 8));
    });

    it("clamps timestamps before Discord's epoch", () => {
        expect(syntheticPhotoId(0, 1)).toBe("1");
    });
});

describe("makePhotoId", () => {
    it("mints a managed id from the live clock", async () => {
        const id = await Effect.runPromise(makePhotoId);
        expect(photoKey("cats", id)).toBe(`cats/${id}.webp`);
    });
});

describe("parseManagedKey", () => {
    it("splits a managed key of either collection", () => {
        expect(parseManagedKey(MANAGED_KEY)).toEqual({
            tag: "cats",
            id: "123456789012345678",
        });
        expect(parseManagedKey("life/123456789012345678.webp")).toEqual({
            tag: "life",
            id: "123456789012345678",
        });
    });

    it("refuses keys the gallery would not list", () => {
        expect(parseManagedKey("life/x.webp")).toBeNull();
        expect(parseManagedKey("cats/123.webp")).toBeNull();
        expect(parseManagedKey("cats/123456789012345678.png")).toBeNull();
        expect(parseManagedKey("../cats/123456789012345678.webp")).toBeNull();
        expect(
            parseManagedKey("cats/123456789012345678.webp/../../life/123456789012345678.webp"),
        ).toBeNull();
    });
});
