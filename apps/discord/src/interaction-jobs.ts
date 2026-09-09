/**
 * Deferred-response plumbing shared by every mutating interaction flow.
 *
 * Discord requires an interaction ACK within three seconds, while the bot's
 * writes (KV/R2/image work) take longer and may need follow-up edits. dfx
 * unconditionally POSTs the handler's returned response and closes its
 * per-interaction scope afterwards, so handlers cannot fork long work
 * themselves. This module owns that lifetime:
 *
 * 1. the handler authorizes, validates and builds its mutation as a closed
 *    job, then stores it with {@link queueJob};
 * 2. the handler returns one deferred response;
 * 3. {@link makePostHandler} — dfx's `postHandler` — awaits the successful
 *    response POST and only then forks the queued job into the application
 *    scope. A failed ACK starts no job.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { DiscordREST } from "dfx";
import { Interaction } from "dfx/Interactions/index";
import type { DiscordRestService } from "dfx/DiscordREST";
import * as Discord from "dfx/types";
import { BotConfig } from "./config.ts";

/**
 * Per-interaction slot for one queued job effect. Provided around the whole
 * response effect, so handlers see it while dfx's response POST is still
 * pending.
 */
export interface PendingInteractionJobService {
    readonly ref: Ref.Ref<Option.Option<Effect.Effect<void>>>;
}

export class PendingInteractionJob extends Context.Service<
    PendingInteractionJob,
    PendingInteractionJobService
>()("@artisann-port/discord/PendingInteractionJob") {}

/**
 * Store the job to run after the deferred response has been POSTed
 * successfully. The job must already have every service requirement resolved
 * by its closure and must never fail (see {@link asJob}).
 */
export const queueJob = (job: Effect.Effect<void>) =>
    Effect.gen(function* () {
        const pending = yield* PendingInteractionJob;
        yield* Ref.set(pending.ref, Option.some(job));
    });

/** Deny message for any interaction outside the configured guild/owner pair. */
export const PRIVATE_BOT_MESSAGE = "This bot is private.";

/** Ephemeral message for custom ids whose entry disappeared from the document. */
export const MISSING_ENTRY_MESSAGE = "That entry no longer exists.";

/** Immediate ephemeral message response (type 4). */
export const ephemeralResponse = (content: string): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: Discord.MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
});

/** Deferred ephemeral ACK for modal submits, regardless of where they were opened. */
export const deferredEphemeralAck = {
    type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: Discord.MessageFlags.Ephemeral },
} satisfies Discord.CreateInteractionResponseRequest;

/** Deferred update ACK for message-component clicks that mutate storage. */
export const deferredComponentAck = {
    type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
} satisfies Discord.CreateInteractionResponseRequest;

/**
 * Both owner checks: the interaction happened in the configured guild, from
 * the configured owner. Denied interactions must touch no storage.
 */
export const authorizeOwner = Effect.gen(function* () {
    const interaction = yield* Interaction;
    const config = yield* BotConfig;
    const userId = interaction.member?.user.id ?? interaction.user?.id;
    return interaction.guild_id === config.serverId && userId === config.userId;
});

/**
 * PATCH the interaction's original response. Used by queued jobs to report
 * their outcome; failures are the caller's responsibility to log.
 */
export const editOriginalResponse = Effect.fn("Commands.editOriginalResponse")(function* (
    interaction: Discord.APIInteraction,
    payload: Discord.IncomingWebhookUpdateRequestPartial,
) {
    const rest = yield* DiscordREST;
    const config = yield* BotConfig;
    yield* rest.updateOriginalWebhookMessage(config.clientId, interaction.token, {
        payload: { allowed_mentions: { parse: [] }, ...payload },
    });
});

/**
 * Errors whose `message` this bot authored for the owner to read. Everything
 * else — dfx REST failures, HTTP client errors, provider errors — carries the
 * authenticated request, the response body, or an upstream URL, so its text
 * is never shown or logged.
 */
const UserFacingError = Schema.Struct({
    _tag: Schema.Literals(["Discord.AttachmentError", "Discord.ContentValidationError"]),
    message: Schema.String,
});
const decodeUserFacing = Schema.decodeUnknownOption(UserFacingError);

/** Storage's own sanitized failure: an operation name and an HTTP status. */
const StorageError = Schema.TaggedStruct("Discord.BotStorageError", {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Finite),
});
const decodeStorageError = Schema.decodeUnknownOption(StorageError);

/** Discord message content is bounded; owner-facing messages are one line. */
const MAX_DESCRIPTION = 200;

const oneLine = (message: string): string => {
    const collapsed = message.replaceAll(/\s+/gu, " ").trim();
    if (collapsed === "") return "an unexpected error";
    return collapsed.length > MAX_DESCRIPTION
        ? `${collapsed.slice(0, MAX_DESCRIPTION - 1)}…`
        : collapsed;
};

/**
 * A one-line summary that is safe to show the owner and to log: the message of
 * an approved domain error, a fixed sentence built from storage's operation
 * and status, or a constant. Arbitrary `message` fields are never echoed.
 */
export const describeError = (cause: unknown): string => {
    if (Cause.isTimeoutError(cause)) return "the operation took too long";
    const userFacing = decodeUserFacing(cause);
    if (Option.isSome(userFacing)) return oneLine(userFacing.value.message);
    const storage = decodeStorageError(cause);
    if (Option.isSome(storage)) {
        const { operation, status } = storage.value;
        return status === null
            ? `storage rejected the ${operation}`
            : `storage rejected the ${operation} (HTTP ${status})`;
    }
    return "an unexpected error";
};

interface JobReporter {
    readonly rest: DiscordRestService;
    readonly clientId: string;
}

const reportJobFailure = (
    reporter: JobReporter,
    interaction: Discord.APIInteraction,
    message: string,
) =>
    reporter.rest
        .updateOriginalWebhookMessage(reporter.clientId, interaction.token, {
            payload: {
                content: `Something went wrong: ${message}`,
                allowed_mentions: { parse: [] },
            },
        })
        .pipe(
            Effect.catchCause(() =>
                Effect.logError("Failed to report the job error on the original response"),
            ),
        );

/**
 * Bound a queued mutation to 120 seconds and turn every outcome into a safe
 * follow-up edit of the original response. Expected failures PATCH a
 * sanitized message; defects and the failure to PATCH itself are logged, not
 * retried.
 */
export const asJob = <E>(
    reporter: JobReporter,
    interaction: Discord.APIInteraction,
    work: Effect.Effect<void, E, never>,
): Effect.Effect<void> =>
    work.pipe(
        Effect.timeout("120 seconds"),
        Effect.catch((error) => reportJobFailure(reporter, interaction, describeError(error))),
        Effect.catchCause(() => Effect.logError("Job ended unexpectedly")),
    );

/**
 * Build dfx's `postHandler`. The returned wrapper allocates the interaction's
 * job slot, awaits the response POST, and on success forks the queued job
 * into `appScope` — the application-lifetime scope captured where `runIx` is
 * launched. A failed or defecting response POST starts no job and is logged
 * instead of killing the interaction loop.
 */
export const makePostHandler =
    (appScope: Scope.Scope) =>
    <R, TE>(
        respond: Effect.Effect<void, TE, R>,
    ): Effect.Effect<void, never, Exclude<R, PendingInteractionJob>> =>
        Effect.gen(function* () {
            const ref = yield* Ref.make(Option.none<Effect.Effect<void>>());
            const outcome = yield* Effect.exit(
                Effect.provideService(respond, PendingInteractionJob, { ref }),
            );
            if (!Exit.isSuccess(outcome)) {
                yield* Effect.logError("Interaction response failed; no queued job was started");
                return;
            }
            const job = yield* Ref.get(ref);
            if (Option.isSome(job)) yield* Effect.forkIn(job.value, appScope);
        });
