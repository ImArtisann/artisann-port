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
}

const photoWorld = (exchanges: Array<Exchange>) => {
    const transport = HttpClient.make((request, url) =>
        Effect.sync(() => {
            exchanges.push({
                method: request.method,
                operationId: request.headers["x-photo-operation-id"],
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

    it("reports the sent operation ID when a deletion outcome is unknown", async () => {
        const exchanges: Array<Exchange> = [];
        const failure = await Effect.runPromise(
            Effect.gen(function* () {
                const photos = yield* BotPhotoClient;
                return yield* photos.deletePhoto("life", "123456789012345678").pipe(Effect.flip);
            }).pipe(Effect.provide(photoWorld(exchanges))),
        );
        const sent = exchanges.find((exchange) => exchange.method === "DELETE")?.operationId;
        expect(sent).toMatch(/^discord:delete:[0-9a-f-]{36}$/u);
        expect(failure.operationId).toBe(sent);
        expect(describeError(failure)).toContain(`reconcile operation ${sent}`);
    });
});
