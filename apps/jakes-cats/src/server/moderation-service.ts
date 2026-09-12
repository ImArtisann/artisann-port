/**
 * Remote comment moderation: the profanity verdict lives behind the free
 * profanity.dev API so no blocklist is committed to this repo. One POST per
 * comment, judged before any storage write; a provider failure fails closed —
 * the comment is refused rather than stored unmoderated.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const MODERATION_URL = "https://vector.profanity.dev";

const ModerationVerdict = Schema.Struct({
    isProfanity: Schema.Boolean,
    score: Schema.Finite,
});

export class ModerationError extends Schema.TaggedError<ModerationError>()("Moderation.Error", {
    reason: Schema.Literals(["Unavailable"]),
}) {}

export class ModerationService extends Context.Service<
    ModerationService,
    { readonly isProfane: (body: string) => Effect.Effect<boolean, ModerationError> }
>()("Moderation.Service") {}

/** Fixed profanity.dev provider; the comment body is the only caller input. */
export const ModerationLive = Layer.effect(
    ModerationService,
    Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const isProfane = Effect.fn("Moderation.isProfane")(function* (body: string) {
            const request = HttpClientRequest.post(MODERATION_URL, {
                headers: { accept: "application/json" },
            }).pipe(HttpClientRequest.bodyJsonUnsafe({ message: body }));
            const verdict = yield* client.execute(request).pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ModerationVerdict)),
                Effect.timeout("8 seconds"),
                // The provider does not need this site's trace context.
                Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                Effect.mapError(() => new ModerationError({ reason: "Unavailable" })),
            );
            return verdict.isProfanity;
        });
        return ModerationService.of({ isProfane });
    }),
);
