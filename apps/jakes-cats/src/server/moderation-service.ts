/**
 * Remote comment moderation: the profanity verdict lives behind the free
 * profanity.dev API so no blocklist is committed to this repo. The provider
 * accepts at most 35 whitespace-separated words per request, while comments
 * can reach 280 characters, so longer bodies are judged as overlapping word
 * windows — every word is covered and a flag or failure in any window fails
 * closed: the comment is refused rather than stored unmoderated.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const MODERATION_URL = "https://vector.profanity.dev";

/** Provider limit: at most this many whitespace-separated words per request. */
const MAX_WORDS_PER_REQUEST = 35;
/**
 * Adjacent windows share this many words so a phrase spanning a boundary is
 * still seen whole by the provider.
 */
const WINDOW_OVERLAP_WORDS = 5;
const WINDOW_STRIDE = MAX_WORDS_PER_REQUEST - WINDOW_OVERLAP_WORDS;

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

/**
 * Split a comment into provider-sized requests: whitespace is normalized,
 * then words are windowed into chunks of at most `MAX_WORDS_PER_REQUEST`,
 * overlapping by `WINDOW_OVERLAP_WORDS`. A 280-character comment yields at
 * most five windows; short comments stay a single request. Every word of the
 * normalized body appears in at least one window — nothing is truncated.
 */
const moderationWindows = (body: string): ReadonlyArray<string> => {
    const normalized = body.trim().replace(/\s+/g, " ");
    const words = normalized.length === 0 ? [] : normalized.split(" ");
    if (words.length <= MAX_WORDS_PER_REQUEST) return [normalized];
    const windows: Array<string> = [];
    for (let start = 0; start < words.length; start += WINDOW_STRIDE) {
        windows.push(words.slice(start, start + MAX_WORDS_PER_REQUEST).join(" "));
        if (start + MAX_WORDS_PER_REQUEST >= words.length) break;
    }
    return windows;
};

/** Fixed profanity.dev provider; the comment body is the only caller input. */
export const ModerationLive = Layer.effect(
    ModerationService,
    Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const isProfane = Effect.fn("Moderation.isProfane")(function* (body: string) {
            const judge = (message: string) => {
                const request = HttpClientRequest.post(MODERATION_URL, {
                    headers: { accept: "application/json" },
                }).pipe(HttpClientRequest.bodyJsonUnsafe({ message }));
                return client
                    .execute(request)
                    .pipe(
                        Effect.flatMap(HttpClientResponse.filterStatusOk),
                        Effect.flatMap(HttpClientResponse.schemaBodyJson(ModerationVerdict)),
                    );
            };
            const verdicts = yield* Effect.forEach(moderationWindows(body), judge, {
                concurrency: 2,
            }).pipe(
                // One budget across every window of this comment.
                Effect.timeout("8 seconds"),
                // The provider does not need this site's trace context.
                Effect.provideService(HttpClient.TracerPropagationEnabled, false),
                Effect.mapError(() => new ModerationError({ reason: "Unavailable" })),
            );
            return verdicts.some((verdict) => verdict.isProfanity);
        });
        return ModerationService.of({ isProfane });
    }),
);
