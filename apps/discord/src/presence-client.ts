import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";
import { BotPortfolioClient, boundedApiOperation } from "./portfolio-client.ts";
import { BotStorageError } from "./portfolio-client.ts";

export interface BotPresenceClientService {
    readonly loadPresence: Effect.Effect<PresenceSnapshot | null, BotStorageError>;
    readonly savePresence: (snapshot: PresenceSnapshot) => Effect.Effect<void, BotStorageError>;
}

export class BotPresenceClient extends Context.Service<
    BotPresenceClient,
    BotPresenceClientService
>()("Discord.BotPresenceClient") {}

export const BotPresenceClientLive: Layer.Layer<BotPresenceClient, never, BotPortfolioClient> =
    Layer.effect(
        BotPresenceClient,
        Effect.gen(function* () {
            const clients = yield* BotPortfolioClient;
            const loadPresence = Effect.fn("BotPresenceClient.loadPresence")(function* () {
                return yield* boundedApiOperation("loadPresence", clients.presence);
            });
            const savePresence = Effect.fn("BotPresenceClient.savePresence")(function* (
                snapshot: PresenceSnapshot,
            ) {
                yield* boundedApiOperation("savePresence", clients.publishPresence(snapshot));
            });
            return BotPresenceClient.of({ loadPresence: loadPresence(), savePresence });
        }),
    );
