import { describe, expect, it } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import { BotConfig, BotConfigLive } from "../src/config.ts";

const baseEnvironment = {
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_BOT_CLIENT_ID: "100000000000000001",
    DISCORD_SERVER_ID: "200000000000000002",
    DISCORD_USER_ID: "300000000000000003",
    DISCORD_NOTES_CHANNEL_ID: "400000000000000004",
    DISCORD_NOTES_WEBHOOK_ID: "500000000000000005",
    DISCORD_NOTES_WEBHOOK_URL: "https://discord.example/webhook",
    PORTFOLIO_API_URL: "https://presence.artisann.dev/",
    CONTENT_WRITER_TOKEN: "writer-token",
    ASSETS_HOST: "assets.artisann.dev",
};

const load = (environment: Record<string, string>) =>
    Effect.runPromise(
        Effect.result(
            Effect.provide(
                BotConfig,
                BotConfigLive.pipe(
                    Layer.provide(
                        ConfigProvider.layer(
                            ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
                        ),
                    ),
                ),
            ),
        ),
    );

describe("Discord configuration", () => {
    it("accepts a production HTTPS origin and exposes the shared writer settings", async () => {
        const result = await load(baseEnvironment);

        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result)) {
            expect(result.success.portfolioApiUrl).toBe("https://presence.artisann.dev/");
            expect(result.success.assetsHost).toBe("assets.artisann.dev");
            expect(Redacted.value(result.success.contentWriterToken)).toBe("writer-token");
        }
    });

    it.each([
        ["surrounding whitespace", " https://presence.artisann.dev/"],
        ["a non-root path", "https://presence.artisann.dev/rpc"],
        ["a query string", "https://presence.artisann.dev/?debug=1"],
        ["credentials", "https://user:password@presence.artisann.dev/"],
        ["non-loopback HTTP", "http://presence.artisann.dev:1338/"],
        ["loopback HTTP without a port", "http://localhost/"],
    ])("rejects %s", async (_reason, portfolioApiUrl) => {
        const result = await load({ ...baseEnvironment, PORTFOLIO_API_URL: portfolioApiUrl });

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
                _tag: "Discord.BotConfigError",
                variable: "PORTFOLIO_API_URL",
            });
            expect(JSON.stringify(result.failure)).not.toContain("writer-token");
        }
    });

    it("rejects an empty writer token without exposing secret values", async () => {
        const result = await load({ ...baseEnvironment, CONTENT_WRITER_TOKEN: "" });

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
                _tag: "Discord.BotConfigError",
                variable: "CONTENT_WRITER_TOKEN",
            });
            expect(JSON.stringify(result.failure)).not.toContain("writer-token");
        }
    });
});
