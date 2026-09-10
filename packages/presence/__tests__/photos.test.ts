import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
    collectPhotos,
    readPhotos,
    type Photo,
    type PhotoPage,
    type PhotosR2Binding,
    type PhotosR2Object,
} from "../src/photos.ts";

const HOST = "assets.artisann.dev";

const photo = (id: string, uploadedAt: string): Photo => ({
    key: `life/${id}.webp`,
    url: `https://assets.artisann.dev/life/${id}.webp`,
    uploadedAt,
});

describe("complete photo traversal", () => {
    it("follows filtered-empty pages and sorts timestamp ties by managed identity", async () => {
        const first = photo("10000000000000001", "2026-09-08T00:00:00.000Z");
        const second = photo("10000000000000002", "2026-09-08T00:00:00.000Z");
        const older = photo("10000000000000003", "2026-09-07T00:00:00.000Z");
        const pages = new Map<string | undefined, PhotoPage>([
            [undefined, { tag: "life", photos: [], nextCursor: "A" }],
            ["A", { tag: "life", photos: [older, second], nextCursor: "B" }],
            ["B", { tag: "life", photos: [first], nextCursor: null }],
        ]);
        const result = await Effect.runPromise(
            collectPhotos("life", (cursor) => {
                const page = pages.get(cursor);
                return page ? Effect.succeed(page) : Effect.die("Unexpected page");
            }),
        );
        expect(result.map((item) => item.key)).toEqual([first.key, second.key, older.key]);
    });

    it("rejects an A-to-B-to-A cursor cycle", async () => {
        const pages = new Map<string | undefined, string>([
            [undefined, "A"],
            ["A", "B"],
            ["B", "A"],
        ]);
        await expect(
            Effect.runPromise(
                collectPhotos("life", (cursor) =>
                    Effect.succeed({
                        tag: "life",
                        photos: [],
                        nextCursor: pages.get(cursor) ?? null,
                    }),
                ),
            ),
        ).rejects.toMatchObject({ _tag: "Photos.Error" });
    });

    it("rejects another collection instead of displaying its photos", async () => {
        for (const page of [
            { tag: "cats", photos: [], nextCursor: null },
            {
                tag: "life",
                photos: [
                    {
                        ...photo("10000000000000001", "2026-09-08T00:00:00.000Z"),
                        key: "cats/10000000000000001.webp",
                    },
                ],
                nextCursor: null,
            },
        ] satisfies PhotoPage[]) {
            await expect(
                Effect.runPromise(collectPhotos("life", () => Effect.succeed(page))),
            ).rejects.toMatchObject({ _tag: "Photos.Error" });
        }
    });

    it("fails the entire traversal when a later page is unavailable", async () => {
        const failure = new Error("later page unavailable");
        await expect(
            Effect.runPromise(
                collectPhotos("life", (cursor) =>
                    cursor === undefined
                        ? Effect.succeed({
                              tag: "life",
                              photos: [photo("10000000000000001", "2026-09-08T00:00:00.000Z")],
                              nextCursor: "A",
                          })
                        : Effect.fail(failure),
                ),
            ),
        ).rejects.toBe(failure);
    });
});

describe("native R2 page adapter", () => {
    it("filters unmanaged keys while preserving a continuation cursor", async () => {
        const uploaded = new Date("2026-09-08T03:00:00.000Z");
        const unmanaged: PhotosR2Object = { key: "life/notes.txt", uploaded };
        const seen: Array<{ prefix: string; limit: number }> = [];
        const namespace: PhotosR2Binding = {
            list: (options) => {
                seen.push({ prefix: options.prefix, limit: options.limit });
                return Promise.resolve({
                    objects: [unmanaged],
                    truncated: true,
                    cursor: "cursor-1",
                });
            },
        };

        await expect(
            Effect.runPromise(readPhotos(namespace, "life", undefined, HOST)),
        ).resolves.toEqual({
            tag: "life",
            photos: [],
            nextCursor: "cursor-1",
        });
        expect(seen).toEqual([{ prefix: "life/", limit: 100 }]);
    });

    it("maps a terminal native page with its own undefined cursor", async () => {
        const namespace: PhotosR2Binding = {
            list: () =>
                Promise.resolve({
                    objects: [
                        {
                            key: "life/1234567890123456789.webp",
                            uploaded: new Date("2026-09-08T03:00:00.000Z"),
                        },
                    ],
                    truncated: false,
                    cursor: undefined,
                }),
        };

        await expect(
            Effect.runPromise(readPhotos(namespace, "life", undefined, HOST)),
        ).resolves.toEqual({
            tag: "life",
            photos: [
                {
                    key: "life/1234567890123456789.webp",
                    url: `https://${HOST}/life/1234567890123456789.webp`,
                    uploadedAt: "2026-09-08T03:00:00.000Z",
                },
            ],
            nextCursor: null,
        });
    });

    it("rejects a truncated native page without a usable cursor", async () => {
        const namespace: PhotosR2Binding = {
            list: () =>
                Promise.resolve({
                    objects: [
                        {
                            key: "life/1234567890123456789.webp",
                            uploaded: new Date("2026-09-08T03:00:00.000Z"),
                        },
                    ],
                    truncated: true,
                }),
        };

        await expect(
            Effect.runPromise(readPhotos(namespace, "life", undefined, HOST)),
        ).rejects.toMatchObject({ _tag: "Photos.Error", operation: "r2.list" });
    });

    it("rejects a malformed native object page", async () => {
        const namespace: PhotosR2Binding = {
            // Deliberately malformed provider output. Only readPhotos may validate its shape.
            list: async () =>
                JSON.parse(
                    '{"objects":[{"key":"life/1234567890123456789.webp","uploaded":"not-a-date"}],"truncated":false}',
                ),
        };

        await expect(
            Effect.runPromise(readPhotos(namespace, "life", undefined, HOST)),
        ).rejects.toMatchObject({ _tag: "Photos.Error", operation: "r2.list" });
    });

    it("rejects an invalid configured assets host before listing", async () => {
        let calls = 0;
        const namespace: PhotosR2Binding = {
            list: () => {
                calls += 1;
                return Promise.resolve({ objects: [], truncated: false });
            },
        };

        await expect(
            Effect.runPromise(readPhotos(namespace, "life", undefined, "http://evil.example")),
        ).rejects.toMatchObject({ _tag: "Photos.Error", operation: "r2.list" });
        expect(calls).toBe(0);
    });
});
