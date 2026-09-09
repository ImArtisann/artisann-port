import { describe, expect, it, vi } from "vite-plus/test";
import type { R2Object } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { ApiUnavailable } from "../src/api-errors.ts";
import { CmsContentService } from "../src/cms-service.ts";
import { DEFAULT_SITE_CONTENT } from "../src/content.ts";
import type { ContentWriterAction } from "../src/content-writer.ts";
import { GithubService } from "../src/github.ts";
import { NotesService } from "../src/notes-service.ts";
import { PhotosBinding, PhotosConfig, PhotosLive, PhotosService } from "../src/photos-service.ts";
import { PresenceService } from "../src/presence-service.ts";
import { PublicRpcs, WriterRpcs } from "../src/rpc.ts";
import { publicRpcProtocol, writerRpcProtocol } from "../src/rpc-transport.ts";
import { handleRpcRequest } from "../src/rpc-server.ts";
import { UNINITIALIZED_SNAPSHOT } from "../src/schema.ts";
import { WeatherService } from "../src/weather-service.ts";

const token = "isolated-rpc-token";
function domainFixture(photoLayer?: Layer.Layer<PhotosService>) {
    const uploaded: Uint8Array[] = [];
    const unavailable = Effect.fail(new ApiUnavailable({ operation: "fixture.unavailable" }));
    const layer = Layer.mergeAll(
        Layer.succeed(CmsContentService, {
            get: Effect.succeed(DEFAULT_SITE_CONTENT),
            readState: Effect.succeed({
                revision: 0,
                publishedRevision: 0,
                content: DEFAULT_SITE_CONTENT,
            }),
            apply: () => unavailable,
        }),
        photoLayer ??
            Layer.succeed(PhotosService, {
                listPage: (tag) => Effect.succeed({ tag, photos: [], nextCursor: null }),
                upload: (tag, id, bytes) =>
                    Effect.sync(() => {
                        uploaded.push(bytes);
                        return `${tag}/${id}.webp`;
                    }),
                delete: () => Effect.void,
            }),
        Layer.succeed(PresenceService, {
            get: Effect.succeed(UNINITIALIZED_SNAPSHOT),
            publish: () => unavailable,
        }),
        Layer.succeed(GithubService, { get: unavailable }),
        Layer.succeed(WeatherService, {
            get: Effect.succeed({ temperature: 23.75, unit: "°C" }),
        }),
        Layer.succeed(NotesService, { submit: (raw) => Effect.die(raw) }),
    );
    const config = { writerToken: Redacted.make(token), websiteOrigin: "http://localhost:3000" };
    const fetch: typeof globalThis.fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
            handleRpcRequest(
                input instanceof Request
                    ? new Request(input, init)
                    : new Request(String(input), init),
                layer,
                config,
            ),
        { preconnect: globalThis.fetch.preconnect },
    );
    const http = FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    const writerProtocol = writerRpcProtocol(
        "http://localhost/rpc/writer",
        Redacted.make(token),
    ).pipe(Layer.provide(http));
    const publicProtocol = publicRpcProtocol("http://localhost/rpc").pipe(Layer.provide(http));
    return { uploaded, layer, config, writerProtocol, publicProtocol };
}

describe("native HTTP RPC boundary", () => {
    it("denies missing, empty and wrong writer credentials before reading upload bytes", async () => {
        const fixture = domainFixture();
        for (const [configured, authorization] of [
            [token, null],
            ["", "Bearer "],
            [token, "Bearer wrong"],
        ] as const) {
            let reads = 0;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        reads++;
                        controller.enqueue(new Uint8Array([1]));
                    },
                },
                { highWaterMark: 0 },
            );
            const request = new Request("http://localhost/rpc/writer", {
                method: "POST",
                headers: authorization ? { authorization } : {},
                body,
                duplex: "half",
            });
            const response = await handleRpcRequest(request, fixture.layer, {
                ...fixture.config,
                writerToken: Redacted.make(configured),
            });
            expect(response.status).toBe(401);
            expect(reads).toBe(0);
            expect(response.headers.get("access-control-allow-origin")).toBeNull();
            await request.body?.cancel();
        }
        expect(fixture.uploaded).toEqual([]);
    });

    it("serves typed public values through NDJSON with no browser cache", async () => {
        const fixture = domainFixture();
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* RpcClient.make(PublicRpcs, { flatten: true });
                    return yield* client("weather.get", {});
                }).pipe(Effect.provide(fixture.publicProtocol)),
            ),
        );
        expect(result).toEqual({ temperature: 23.75, unit: "°C" });
    });

    it("round-trips a 20 MiB binary payload without the default 16 MiB frame limit", async () => {
        const fixture = domainFixture();
        // Codec-size fixture only: image validity belongs to PhotosLive.
        const bytes = new Uint8Array(20 * 1024 * 1024);
        bytes[0] = 127;
        bytes[bytes.length - 1] = 219;
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* RpcClient.make(WriterRpcs, { flatten: true });
                    return yield* client("photos.upload", {
                        tag: "cats",
                        interactionId: "12345678901234567",
                        bytes,
                    });
                }).pipe(Effect.provide(fixture.writerProtocol)),
            ),
        );
        expect(result).toBe("cats/12345678901234567.webp");
        expect(fixture.uploaded).toHaveLength(1);
        expect(Buffer.compare(fixture.uploaded[0] ?? new Uint8Array(), bytes)).toBe(0);
    });

    it("stores genuine normalized WebP bytes and fixed native metadata through writer RPC", async () => {
        const writes: Array<{ key: string; bytes: unknown; metadata: unknown }> = [];
        const photos = PhotosLive.pipe(
            Layer.provide(
                Layer.mergeAll(
                    Layer.succeed(PhotosConfig, { assetsHost: "assets.artisann.dev" }),
                    Layer.succeed(PhotosBinding, {
                        list: async () => ({ objects: [], truncated: false, cursor: undefined }),
                        put: async (key, bytes, options) => {
                            writes.push({ key, bytes, metadata: options?.httpMetadata });
                            const acknowledged = {
                                key,
                                version: "fixture-version",
                                size: bytes instanceof Uint8Array ? bytes.byteLength : 0,
                                etag: "fixture-etag",
                                httpEtag: '"fixture-etag"',
                                uploaded: new Date("2026-09-09T00:00:00.000Z"),
                                checksums: { toJSON: () => ({}) },
                                httpMetadata: {
                                    contentType: "image/webp",
                                    cacheControl: "public, max-age=60, must-revalidate",
                                },
                                customMetadata: {},
                                storageClass: "Standard",
                                writeHttpMetadata: (headers) => {
                                    headers.set("content-type", "image/webp");
                                    headers.set(
                                        "cache-control",
                                        "public, max-age=60, must-revalidate",
                                    );
                                },
                            } satisfies R2Object;
                            return acknowledged;
                        },
                        delete: async () => undefined,
                    }),
                ),
            ),
        );
        const fixture = domainFixture(photos);
        // Generated with the bot's pinned sharp, 1×1 RGB, quality-82 WebP.
        const bytes = new Uint8Array(
            Buffer.from(
                "UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoBAAEAAUAiJYwCdAFAAAD+88JmtcrVpVuDZIpdgAA=",
                "base64",
            ),
        );
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* RpcClient.make(WriterRpcs, { flatten: true });
                    yield* client("photos.upload", {
                        tag: "life",
                        interactionId: "12345678901234567",
                        bytes,
                    });
                }).pipe(Effect.provide(fixture.writerProtocol)),
            ),
        );
        expect(writes).toEqual([
            {
                key: "life/12345678901234567.webp",
                bytes,
                metadata: {
                    contentType: "image/webp",
                    cacheControl: "public, max-age=60, must-revalidate",
                },
            },
        ]);
    });

    it("transports every authority action variant to its typed service failure", async () => {
        const fixture = domainFixture();
        const actions: ContentWriterAction[] = [
            { action: "replace", revision: 0, content: DEFAULT_SITE_CONTENT },
            {
                action: "approve",
                id: "a".repeat(32),
                name: null,
                body: "A note",
                submittedAt: "2026-09-09T00:00:00.000Z",
            },
            { action: "reject", id: "b".repeat(32) },
        ];
        const results = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* RpcClient.make(WriterRpcs, { flatten: true });
                    return yield* Effect.forEach(actions, (action) =>
                        client("content.apply", action).pipe(Effect.result),
                    );
                }).pipe(Effect.provide(fixture.writerProtocol)),
            ),
        );
        for (const result of results) {
            expect(result).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "ApiUnavailable", operation: "fixture.unavailable" },
            });
        }
    });

    it("caps actual streamed public bytes instead of trusting Content-Length", async () => {
        const fixture = domainFixture();
        const response = await handleRpcRequest(
            new Request("http://localhost/rpc", {
                method: "POST",
                body: new Uint8Array(16 * 1024 + 1),
            }),
            fixture.layer,
            fixture.config,
        );
        expect(response.status).toBe(413);
        expect(fixture.uploaded).toEqual([]);
    });

    it("enforces the note framing budget with exact-origin CORS", async () => {
        const fixture = domainFixture();
        const response = await handleRpcRequest(
            new Request("http://localhost/rpc/notes", {
                method: "POST",
                headers: { origin: "http://localhost:3000" },
                body: new Uint8Array(8 * 1024 + 1),
            }),
            fixture.layer,
            fixture.config,
        );
        expect(response.status).toBe(413);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("abandons a stalled body after the five-second read deadline", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const fixture = domainFixture();
            let cancelled = false;
            const request = new Request("http://localhost/rpc", {
                method: "POST",
                body: new ReadableStream<Uint8Array>({
                    cancel() {
                        cancelled = true;
                    },
                }),
                duplex: "half",
            });
            const pending = handleRpcRequest(request, fixture.layer, fixture.config);
            await vi.advanceTimersByTimeAsync(5_000);
            expect((await pending).status).toBe(413);
            expect(cancelled).toBe(true);
            expect(fixture.uploaded).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
