/**
 * Bot configuration: every variable the owner-only runtime needs, decoded once
 * at startup through Effect Config.
 *
 * Failures name the variable and a fixed, value-free reason: a rejected value
 * is never echoed back into an error, a log, or a span, because several of
 * these variables are secrets. Optional asset settings fall back to the shared
 * assets defaults only when the variable is absent.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import { isPortfolioApiOrigin } from "@artisann-port/presence/config";

/** Startup refused a variable. `issue` is a fixed phrase, never the value. */
export class BotConfigError extends Schema.TaggedError<BotConfigError>()("Discord.BotConfigError", {
    variable: Schema.String,
    issue: Schema.String,
}) {}

/** Discord snowflakes as the shared content contract defines them. */
const SNOWFLAKE = /^[0-9]{17,20}$/u;

/** A bare hostname: no scheme, port, path, or query. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/iu;

/** The decoded, validated configuration every bot service is built from. */
export interface BotConfigService {
    /** Bot account token (redacted). */
    readonly token: Redacted.Redacted<string>;
    /** Application (client) id, verified against `rest.getMyApplication()`. */
    readonly clientId: string;
    /** The single guild this bot operates in. */
    readonly serverId: string;
    /** The owner/observed user whose presence is published. */
    readonly userId: string;
    /** Private review channel every pending-note message is posted to. */
    readonly notesChannelId: string;
    /** Application-owned webhook id, verified against application and channel. */
    readonly notesWebhookId: string;
    /** Application-owned webhook URL for current-message reads/updates (redacted). */
    readonly notesWebhookUrl: Redacted.Redacted<string>;
    /** Presence Worker origin used by the typed RPC clients. */
    readonly portfolioApiUrl: string;
    /** Shared bearer secret for authenticated writer RPCs (redacted). */
    readonly contentWriterToken: Redacted.Redacted<string>;
    /** Public assets host photo URLs are built from. */
    readonly assetsHost: string;
}

export class BotConfig extends Context.Service<BotConfig, BotConfigService>()(
    "@artisann-port/discord/BotConfig",
) {}

const rawConfig = Config.all({
    token: Config.redacted("DISCORD_BOT_TOKEN"),
    clientId: Config.string("DISCORD_BOT_CLIENT_ID"),
    serverId: Config.string("DISCORD_SERVER_ID"),
    userId: Config.string("DISCORD_USER_ID"),
    notesChannelId: Config.string("DISCORD_NOTES_CHANNEL_ID"),
    notesWebhookId: Config.string("DISCORD_NOTES_WEBHOOK_ID"),
    notesWebhookUrl: Config.redacted("DISCORD_NOTES_WEBHOOK_URL"),
    portfolioApiUrl: Config.string("PORTFOLIO_API_URL"),
    contentWriterToken: Config.redacted("CONTENT_WRITER_TOKEN"),
    assetsHost: Config.string("ASSETS_HOST").pipe(Config.withDefault(DEFAULT_ASSETS_HOST)),
});

/**
 * Accept a value or fail with the variable name and a fixed reason. Every
 * validated variable shares this lockstep behavior, and no branch ever puts
 * the value into the failure.
 */
const require_ = (
    variable: string,
    value: string,
    valid: boolean,
    issue: string,
): Effect.Effect<string, BotConfigError> =>
    valid ? Effect.succeed(value) : Effect.fail(new BotConfigError({ variable, issue }));

/** Strict configuration from the environment; failures name only the variable. */
export const BotConfigLive: Layer.Layer<BotConfig, Config.ConfigError | BotConfigError> =
    Layer.effect(
        BotConfig,
        Effect.gen(function* () {
            const values = yield* rawConfig;
            const snowflake = "Expected a 17-20 digit Discord snowflake";
            const clientId = yield* require_(
                "DISCORD_BOT_CLIENT_ID",
                values.clientId,
                SNOWFLAKE.test(values.clientId),
                snowflake,
            );
            const serverId = yield* require_(
                "DISCORD_SERVER_ID",
                values.serverId,
                SNOWFLAKE.test(values.serverId),
                snowflake,
            );
            const userId = yield* require_(
                "DISCORD_USER_ID",
                values.userId,
                SNOWFLAKE.test(values.userId),
                snowflake,
            );
            const notesChannelId = yield* require_(
                "DISCORD_NOTES_CHANNEL_ID",
                values.notesChannelId,
                SNOWFLAKE.test(values.notesChannelId),
                snowflake,
            );
            const notesWebhookId = yield* require_(
                "DISCORD_NOTES_WEBHOOK_ID",
                values.notesWebhookId,
                SNOWFLAKE.test(values.notesWebhookId),
                snowflake,
            );
            const portfolioApiUrl = yield* require_(
                "PORTFOLIO_API_URL",
                values.portfolioApiUrl,
                isPortfolioApiOrigin(values.portfolioApiUrl),
                "Expected a trimmed HTTPS origin with no credentials, query, or fragment; HTTP is limited to localhost or 127.0.0.1 with an explicit port",
            );
            yield* require_(
                "CONTENT_WRITER_TOKEN",
                Redacted.value(values.contentWriterToken),
                Redacted.value(values.contentWriterToken).length > 0,
                "Expected a non-empty token",
            );
            yield* require_(
                "DISCORD_BOT_TOKEN",
                Redacted.value(values.token),
                Redacted.value(values.token).length > 0,
                "Expected a non-empty token",
            );
            yield* require_(
                "DISCORD_NOTES_WEBHOOK_URL",
                Redacted.value(values.notesWebhookUrl),
                Redacted.value(values.notesWebhookUrl).length > 0,
                "Expected a non-empty webhook URL",
            );
            const assetsHost = yield* require_(
                "ASSETS_HOST",
                values.assetsHost,
                HOSTNAME.test(values.assetsHost),
                "Expected a bare hostname without scheme, port, or path",
            );
            return BotConfig.of({
                token: values.token,
                clientId,
                serverId,
                userId,
                notesChannelId,
                notesWebhookId,
                notesWebhookUrl: values.notesWebhookUrl,
                portfolioApiUrl,
                contentWriterToken: values.contentWriterToken,
                assetsHost,
            });
        }),
    );
