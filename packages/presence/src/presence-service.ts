import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ApiUnavailable } from "./api-errors.ts";
import { PresenceSnapshot } from "./schema.ts";
import type { DurableObjectIdLike } from "./content-writer.ts";

export const PRESENCE_OBJECT_NAME = "presence";

export interface PresenceNamespace {
    idFromName(name: string): DurableObjectIdLike;
    get(id: DurableObjectIdLike): PresenceStub & { fetch(request: Request): Promise<Response> };
}

export interface PresenceStub {
    getSnapshot(): Promise<PresenceSnapshot>;
    publishSnapshot(snapshot: PresenceSnapshot): Promise<PresenceSnapshot>;
}

export class PresenceBinding extends Context.Service<PresenceBinding, PresenceStub>()(
    "Presence.Binding",
) {}

export class PresenceService extends Context.Service<
    PresenceService,
    {
        readonly get: Effect.Effect<PresenceSnapshot, ApiUnavailable>;
        readonly publish: (
            snapshot: PresenceSnapshot,
        ) => Effect.Effect<PresenceSnapshot, ApiUnavailable>;
    }
>()("Presence.Service") {}

export const PresenceLive = Layer.effect(
    PresenceService,
    Effect.gen(function* () {
        const binding = yield* PresenceBinding;
        const decode = Schema.decodeUnknownEffect(PresenceSnapshot);
        const get = Effect.tryPromise({
            try: () => binding.getSnapshot(),
            catch: () => new ApiUnavailable({ operation: "presence.get" }),
        }).pipe(
            Effect.flatMap(decode),
            Effect.mapError(() => new ApiUnavailable({ operation: "presence.get" })),
            Effect.withSpan("Presence.get"),
        );
        const publish = Effect.fn("Presence.publish")(
            function* (snapshot: PresenceSnapshot) {
                const value = yield* decode(snapshot);
                return yield* Effect.tryPromise({
                    try: () => binding.publishSnapshot(value),
                    catch: () => new ApiUnavailable({ operation: "presence.publish" }),
                }).pipe(Effect.flatMap(decode));
            },
            Effect.mapError(() => new ApiUnavailable({ operation: "presence.publish" })),
        );
        return PresenceService.of({ get, publish });
    }),
);
