/**
 * The owner-only bot entrypoint.
 *
 * The runtime is one flat, named layer graph: configuration, the dfx session,
 * RPC clients, and the two workers, each provided exactly once. `runtimeLayer`
 * leaves the WebSocket constructor unprovisioned so a credential-free smoke
 * can substitute its own transport and domain services while
 * still sharing a single Gateway session with the command handlers.
 *
 * Startup verification runs before the workers launch and its failures reach
 * `runMain` directly; nothing important is left to an unobserved fiber.
 */
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/unstable/socket/Socket";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { layerWebSocketConstructor } from "@effect/platform-bun/BunSocket";
import { runMain } from "@effect/platform-bun/BunRuntime";
import * as DfxDiscordConfig from "dfx/DiscordConfig";
import { DiscordLive } from "dfx/gateway";
import { DiscordREST, DiscordRESTLive, MemoryRateLimitStoreLive } from "dfx";
import { BotConfig, BotConfigError, BotConfigLive } from "./config.ts";
import { BotRpcClientsLive, type BotStorageError } from "./rpc-client.ts";
import { BotPresenceClient, BotPresenceClientLive } from "./presence-client.ts";
import { BotPhotoClient, BotPhotoClientLive } from "./photo-client.ts";
import { BotContentClient, BotContentClientLive } from "./content-client.ts";
import { PresenceWorkerLive } from "./presence.ts";
import { CommandsLive, type CommandsStartupError } from "./commands.ts";

/** GUILDS | GUILD_PRESENCES — the only intents this bot needs. */
const GATEWAY_INTENTS = 257;

/** One process, one shard: exactly one writer per namespace. */
const SHARD_COUNT = 1;

/** Discord text channels are type 0. */
const GUILD_TEXT_CHANNEL = 0;

/** Startup identity verification failed for a named variable. */
export class BotStartupError extends Schema.TaggedError<BotStartupError>()(
    "Discord.BotStartupError",
    { variable: Schema.String, issue: Schema.String },
) {}

/** dfx config built from the strict BotConfig service. */
export const discordConfigFromBotConfig: Layer.Layer<
    DfxDiscordConfig.DiscordConfig,
    never,
    BotConfig
> = Layer.effect(
    DfxDiscordConfig.DiscordConfig,
    Effect.map(BotConfig, (config) =>
        DfxDiscordConfig.make({
            token: config.token,
            gateway: { intents: GATEWAY_INTENTS, shardCount: SHARD_COUNT },
        }),
    ),
);

/** Injectable pieces of the runtime; every field has a production default. */
export interface RuntimeLayerOptions {
    /** dfx DiscordConfig layer; the smoke injects a local-REST config here. */
    readonly discordConfig: Layer.Layer<DfxDiscordConfig.DiscordConfig, never, BotConfig>;
    /** Strict bot configuration from the environment. */
    readonly botConfig?: Layer.Layer<BotConfig, Config.ConfigError | BotConfigError>;
    /** Closed domain fakes for isolated runtime scenarios. */
    readonly botPresence?: Layer.Layer<BotPresenceClient>;
    readonly botPhotos?: Layer.Layer<BotPhotoClient>;
    readonly botContent?: Layer.Layer<BotContentClient>;
    /** Shared HTTP transport for site RPC, Discord REST, and attachment downloads. */
    readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
}

/**
 * Presence worker plus commands over one shared dfx session and RPC registry,
 * and one HTTP client. The WebSocket constructor stays a requirement.
 */
export const runtimeLayer = (
    options: RuntimeLayerOptions,
): Layer.Layer<
    never,
    Config.ConfigError | BotConfigError | BotStorageError | CommandsStartupError,
    Socket.WebSocketConstructor
> => {
    const botConfig = options.botConfig ?? BotConfigLive;
    const httpClient = options.httpClient ?? FetchHttpClient.layer;
    const dfxConfig = options.discordConfig.pipe(Layer.provide(botConfig));
    // One DiscordLive value, referenced by both consumers below, so the
    // memoized build gives presence and commands the same Gateway session.
    const discord = DiscordLive.pipe(Layer.provide(Layer.mergeAll(dfxConfig, httpClient)));
    const rpc = BotRpcClientsLive.pipe(Layer.provide(Layer.mergeAll(botConfig, httpClient)));
    const clients = Layer.mergeAll(
        options.botPresence ?? BotPresenceClientLive,
        options.botPhotos ?? BotPhotoClientLive,
        options.botContent ?? BotContentClientLive,
    ).pipe(Layer.provide(Layer.mergeAll(rpc, discord)));
    // The command handlers download attachments with this exact client, so it
    // stays exposed rather than being hidden inside client provisioning.
    const services = Layer.mergeAll(botConfig, clients, discord, httpClient);
    return Layer.mergeAll(PresenceWorkerLive, CommandsLive).pipe(Layer.provide(services));
};

/**
 * Verify the configured identity against Discord before any worker launches:
 * the client id must match the authenticated application, the notes webhook
 * must be application-owned and target the notes channel, and that channel
 * must be a text channel inside the configured guild.
 */
export const verifyStartupIdentity: Effect.Effect<void, BotStartupError, BotConfig | DiscordREST> =
    Effect.gen(function* () {
        const config = yield* BotConfig;
        const rest = yield* DiscordREST;
        const application = yield* rest.getMyApplication().pipe(
            Effect.mapError(
                () =>
                    new BotStartupError({
                        variable: "DISCORD_BOT_TOKEN",
                        issue: "The authenticated application could not be read",
                    }),
            ),
        );
        if (application.id !== config.clientId) {
            return yield* new BotStartupError({
                variable: "DISCORD_BOT_CLIENT_ID",
                issue: "Does not match the application authenticated by DISCORD_BOT_TOKEN",
            });
        }
        const channelRead = yield* Effect.result(rest.getChannel(config.notesChannelId));
        if (Result.isFailure(channelRead)) {
            const status = channelRead.failure.response?.status;
            // Guild sync verifies the channel once installation permits access.
            if (status === 403 || status === 404) return;
            return yield* new BotStartupError({
                variable: "DISCORD_NOTES_CHANNEL_ID",
                issue: "The configured channel could not be read",
            });
        }
        const channel = channelRead.success;
        const channelGuildId = "guild_id" in channel ? channel.guild_id : undefined;
        if (channel.type !== GUILD_TEXT_CHANNEL || channelGuildId !== config.serverId) {
            return yield* new BotStartupError({
                variable: "DISCORD_NOTES_CHANNEL_ID",
                issue: "Must be a text channel inside DISCORD_SERVER_ID",
            });
        }
        const webhook = yield* rest.getWebhook(config.notesWebhookId).pipe(
            Effect.mapError(
                () =>
                    new BotStartupError({
                        variable: "DISCORD_NOTES_WEBHOOK_ID",
                        issue: "The configured webhook could not be read",
                    }),
            ),
        );
        if (
            webhook.application_id !== config.clientId ||
            webhook.channel_id !== config.notesChannelId
        ) {
            return yield* new BotStartupError({
                variable: "DISCORD_NOTES_WEBHOOK_ID",
                issue: "Must be application-owned and target DISCORD_NOTES_CHANNEL_ID",
            });
        }
    });

/** The REST-only context startup verification runs in. */
const identityLayer: Layer.Layer<BotConfig | DiscordREST, Config.ConfigError | BotConfigError> =
    Layer.mergeAll(
        BotConfigLive,
        DiscordRESTLive.pipe(
            Layer.provide(
                Layer.mergeAll(
                    MemoryRateLimitStoreLive,
                    FetchHttpClient.layer,
                    discordConfigFromBotConfig.pipe(Layer.provide(BotConfigLive)),
                ),
            ),
        ),
    );

/** The production application layer, transport included. */
export const productionLayer: Layer.Layer<
    never,
    Config.ConfigError | BotConfigError | BotStorageError | CommandsStartupError
> = runtimeLayer({ discordConfig: discordConfigFromBotConfig }).pipe(
    Layer.provide(layerWebSocketConstructor),
);

/** Production startup: verify identity, then launch every worker. */
export const main: Effect.Effect<
    void,
    BotConfigError | BotStorageError | BotStartupError | CommandsStartupError | Config.ConfigError
> = Effect.gen(function* () {
    yield* Effect.provide(verifyStartupIdentity, identityLayer);
    return yield* Layer.launch(productionLayer);
});

if (import.meta.main) {
    runMain(main);
}
