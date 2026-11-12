import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { photoUrl } from "@artisann-port/presence/photos";
import { BotConfig } from "../src/config.ts";
import { describeError } from "../src/interaction-jobs.ts";
import { BotPhotoClient, BotPhotoClientLive } from "../src/photo-client.ts";
import { BotPortfolioClientLive } from "../src/portfolio-client.ts";

const KEY = "life/123456789012345678.webp";

interface Exchange {
    readonly method: string;
    readonly operationId: string | undefined;
    readonly ifMatch: string | undefined;
}

const photoWorld = (exchanges: Array<Exchange>) => {
    const transport = HttpClient.make((request, url) =>
        Effect.sync(() => {
            exchanges.push({
                method: request.method,
                operationId: request.headers["x-photo-operation-id"],
                ifMatch: request.headers["if-match"],
            });
            if (url.pathname !== "/api/writer/photos")
                return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
            if (request.method === "POST")
                return HttpClientResponse.fromWeb(
                    request,
                    Response.json(
                        {
                            key: KEY,
                            url: `https://assets.example.com/${KEY}`,
                            tag: "life",
                            operationId: request.headers["x-photo-operation-id"],
                            etag: "etag-1",
                        },
                        { status: 201 },
                    ),
                );
            return HttpClientResponse.fromWeb(
                request,
                Response.json(
                    {
                        _tag: "PhotoMutationError",
                        reason: "Uncertain",
                        outcome: "unknown",
                    },
                    { status: 503 },
                ),
            );
        }),
    );
    return BotPhotoClientLive.pipe(
        Layer.provide(BotPortfolioClientLive),
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(HttpClient.HttpClient, transport),
                Layer.succeed(BotConfig, {
                    token: Redacted.make("bot-token"),
                    clientId: "111111111111111111",
                    serverId: "222222222222222222",
                    userId: "333333333333333333",
                    notesChannelId: "444444444444444444",
                    notesWebhookId: "555555555555555555",
                    notesWebhookUrl: Redacted.make(
                        "https://discord.com/api/webhooks/555555555555555555/test",
                    ),
                    portfolioApiUrl: "https://presence.artisann.dev",
                    contentWriterToken: Redacted.make("writer-token"),
                    assetsHost: "assets.example.com",
                }),
            ),
        ),
    );
};

describe("Discord photo owner client", () => {
    it("returns the managed key that the upload reply turns into a public URL", async () => {
        const exchanges: Array<Exchange> = [];
        const key = await Effect.runPromise(
            Effect.gen(function* () {
                const photos = yield* BotPhotoClient;
                return yield* photos.putPhoto(
                    "life",
                    "123456789012345678",
                    new Uint8Array([1, 2, 3]),
                );
            }).pipe(Effect.provide(photoWorld(exchanges))),
        );
        expect(key).toBe(KEY);
        expect(photoUrl(key, "assets.example.com")).toBe(`https://assets.example.com/${KEY}`);
    });

    it("reuses one operation ID per confirmed version so a reconciled retry can resume it", async () => {
        const exchanges: Array<Exchange> = [];
        const failures = await Effect.runPromise(
            Effect.gen(function* () {
                const photos = yield* BotPhotoClient;
                const first = yield* photos
                    .deletePhoto("life", "123456789012345678", "etag-1")
                    .pipe(Effect.flip);
                const retry = yield* photos
                    .deletePhoto("life", "123456789012345678", "etag-1")
                    .pipe(Effect.flip);
                const changed = yield* photos
                    .deletePhoto("life", "123456789012345678", "etag-2")
                    .pipe(Effect.flip);
                return { first, retry, changed };
            }).pipe(Effect.provide(photoWorld(exchanges))),
        );
        const deletes = exchanges.filter((exchange) => exchange.method === "DELETE");
        expect(deletes).toEqual([
            {
                method: "DELETE",
                operationId: "discord:delete:life:123456789012345678:etag-1",
                ifMatch: "etag-1",
            },
            {
                method: "DELETE",
                operationId: "discord:delete:life:123456789012345678:etag-1",
                ifMatch: "etag-1",
            },
            {
                method: "DELETE",
                operationId: "discord:delete:life:123456789012345678:etag-2",
                ifMatch: "etag-2",
            },
        ]);
        expect(failures.first.operationId).toBe(deletes[0]?.operationId);
        expect(failures.retry.operationId).toBe(deletes[0]?.operationId);
        expect(describeError(failures.first)).toContain(
            `reconcile operation ${deletes[0]?.operationId}`,
        );
    });
});
