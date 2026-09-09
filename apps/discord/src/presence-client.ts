import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PresenceSnapshot } from "@artisann-port/presence/schema";
import { BotRpcClients, boundedRpcOperation } from "./rpc-client.ts";
import { BotStorageError } from "./rpc-client.ts";

export interface BotPresenceClientService {
    readonly loadPresence: Effect.Effect<PresenceSnapshot | null, BotStorageError>;
    readonly savePresence: (snapshot: PresenceSnapshot) => Effect.Effect<void, BotStorageError>;
}

export class BotPresenceClient extends Context.Service<
    BotPresenceClient,
    BotPresenceClientService
>()("Discord.BotPresenceClient") {}

export const BotPresenceClientLive: Layer.Layer<BotPresenceClient, never, BotRpcClients> =
    Layer.effect(
        BotPresenceClient,
        Effect.gen(function* () {
            const clients = yield* BotRpcClients;
            const writer = clients.writer;
            const loadPresence = Effect.fn("BotPresenceClient.loadPresence")(function* () {
                return yield* boundedRpcOperation("loadPresence", writer("presence.get", {}));
            });
            const savePresence = Effect.fn("BotPresenceClient.savePresence")(function* (
                snapshot: PresenceSnapshot,
            ) {
                yield* boundedRpcOperation(
                    "savePresence",
                    writer("presence.publish", { snapshot }),
                );
            });
            return BotPresenceClient.of({ loadPresence: loadPresence(), savePresence });
        }),
    );
