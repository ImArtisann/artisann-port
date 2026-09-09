/**
 * Owner moderation of visitor notes through the review channel's
 * Approve/Reject buttons.
 *
 * Every decision is authorized four ways — guild, owner, configured channel
 * and application identity — before anything is read or written, and the
 * current source message is re-fetched through the application-owned webhook
 * on every click, so pending buttons survive container restarts with no
 * in-memory submission cache. The durable decision itself lives in the
 * authoritative content writer through the typed content client: a duplicate
 * or opposing click can never double-publish or resurrect a rejected id, and
 * an uncertain outcome fails closed with the review controls left usable.
 */
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Discord, DiscordREST, Ix } from "dfx";
import type { DiscordRestService, DiscordRESTError } from "dfx/DiscordREST";
import {
    decodeNotePayload,
    noteFinalizedMessage,
    parseDiscordWebhookUrl,
    parseNoteCustomId,
    NoteSubmissionId,
} from "@artisann-port/presence/notes";
import type { BotConfigService } from "./config.ts";
import { BotConfig } from "./config.ts";
import {
    BotContentClient,
    type BotContentClientService,
    type NoteApproval,
} from "./content-client.ts";
import { BotStorageError, ContentValidationError } from "./rpc-client.ts";
import {
    PRIVATE_BOT_MESSAGE,
    deferredComponentAck,
    ephemeralResponse,
    queueJob,
} from "./interaction-jobs.ts";

/** Startup validation refused the configured notes webhook. */
export class NotesWebhookError extends Schema.TaggedError<NotesWebhookError>()(
    "Discord.NotesWebhookError",
    {
        /** Which configuration field failed; never the secret value. */
        field: Schema.String,
        /** Sanitized reason tag, safe to log and to show the owner. */
        reason: Schema.String,
    },
) {}

/** The moderation services one decision job is serialized through. */
export interface NoteModerationService {
    /** Run the effect holding the single decision permit. */
    readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * One moderation permit: every decision job holds it from the source-message
 * fetch through the final Discord update, so two clicks on the same review
 * message (including an Approve/Reject race) run strictly one after another.
 * The durable outcome is the writer's, not this process's.
 */
export class NoteModeration extends Context.Service<NoteModeration, NoteModerationService>()(
    "discord/NoteModeration",
) {}

export const NoteModerationLive: Layer.Layer<NoteModeration> = Layer.effect(
    NoteModeration,
    Effect.map(Semaphore.make(1), (semaphore): NoteModerationService => ({
        withPermit: (effect) => semaphore.withPermits(1)(effect),
    })),
);

/** Everything one decision job needs, captured before the ACK is sent. */
interface DecisionJobInput {
    readonly rest: DiscordRestService;
    /** The interaction token, for ephemeral owner followups after the ACK. */
    readonly interactionToken: string;
    readonly content: BotContentClientService;
    readonly config: BotConfigService;
    readonly webhook: { readonly id: string; readonly token: string };
    readonly action: "approve" | "reject";
    readonly submissionId: string;
    readonly sourceMessageId: string;
}

/** The authoritative current state of one review message, via its webhook. */
const fetchSourceMessage = (input: DecisionJobInput) =>
    input.rest.getWebhookMessage(input.webhook.id, input.webhook.token, input.sourceMessageId);

/**
 * Log a Discord REST failure by its decoded status only; the request and
 * response bodies are never logged. Anything the schema cannot read from
 * the error is a fixed tag.
 */
const DiscordRestFailure = Schema.Struct({
    response: Schema.Struct({ status: Schema.Finite }),
});

const decodeRestStatus = Schema.decodeUnknownOption(DiscordRestFailure);

const restFailureReason = (error: DiscordRESTError | Cause.Cause<unknown>): string =>
    Option.match(decodeRestStatus(error), {
        onNone: () => "rest-error",
        onSome: (decoded) => `http-${decoded.response.status}`,
    });

/** Sanitized, single-line log for one decision failure; never a cause dump. */
const logDecisionFailure = (operation: string, reason: string) =>
    Effect.logError(`Notes: ${operation} failed (${reason})`);

/**
 * Replace the review message with its finalized form: outcome text, no
 * embeds, both buttons removed. A failed edit never un-does the durable
 * outcome — the next click converges through the writer's idempotency.
 */
const finalizeMessage = (input: DecisionJobInput, outcome: "approved" | "rejected" | "malformed") =>
    input.rest
        .updateWebhookMessage(input.webhook.id, input.webhook.token, input.sourceMessageId, {
            payload: noteFinalizedMessage(outcome, input.submissionId),
        })
        .pipe(
            Effect.catchCause((cause) => logDecisionFailure("finalize", restFailureReason(cause))),
        );

/**
 * Tell the owner what happened after the deferred ACK: an ephemeral
 * followup webhook message, mentions disabled. The review message itself is
 * only ever changed by a settled outcome, so review controls survive every
 * failure. A failed followup is logged, never retried as a mutation.
 */
const reportOwner = (input: DecisionJobInput, content: string) =>
    input.rest
        .executeWebhook(input.config.clientId, input.interactionToken, {
            payload: {
                content,
                flags: Discord.MessageFlags.Ephemeral,
                allowed_mentions: { parse: [] },
            },
        })
        .pipe(
            Effect.catchCause((cause) =>
                logDecisionFailure("report-owner", restFailureReason(cause)),
            ),
        );

/** Owner-facing text for one writer refusal, by sanitized status class. */
const writerRefusalMessage = (
    action: "approve" | "reject",
    failure: BotStorageError | ContentValidationError,
): string => {
    if (failure._tag === "Discord.ContentValidationError") {
        return `Publication refused: ${failure.message}`;
    }
    if (failure.status === 422) {
        return "Publication refused: the 100-note capacity is reached or the note is invalid.";
    }
    if (failure.status === 409) {
        return "Publication conflict: this note id already exists with different content.";
    }
    return action === "approve"
        ? "Publication is being finalized; click Approve again to confirm."
        : "Rejection failed; try again.";
};

/**
 * Run one decision against the freshly fetched source message. Every
 * failure mode is fail-closed: the review controls stay usable, nothing is
 * published or rejected on a guess, and no storage mutation happens unless
 * the writer accepted the durable action.
 */
const decisionJob = (input: DecisionJobInput) =>
    Effect.gen(function* () {
        const fetched = yield* Effect.result(fetchSourceMessage(input));
        if (Result.isFailure(fetched)) {
            // A 404 means the review message was deleted: there is nothing
            // to publish and nothing to mutate. Anything else is fail-closed.
            yield* logDecisionFailure("fetch", restFailureReason(fetched.failure));
            return;
        }

        const message = fetched.success;
        const identityMatches =
            message.channel_id === input.config.notesChannelId &&
            message.webhook_id === input.webhook.id &&
            message.application_id === input.config.clientId;
        if (!identityMatches) {
            yield* logDecisionFailure("identity", "source-message-mismatch");
            return;
        }
        if (message.components.length === 0) {
            // The message is already finalized (buttons removed): every
            // later click is stale, and an approved label is never relabeled
            // as malformed or rejected.
            return;
        }

        const footerText = message.embeds[0]?.footer?.text ?? null;
        const payload = footerText === null ? null : decodeNotePayload(footerText);
        if (payload === null) {
            // The message cannot be interpreted: fail closed by removing the
            // controls so stale clicks stop, without touching any storage.
            yield* finalizeMessage(input, "malformed");
            return;
        }
        if (payload.id !== input.submissionId) {
            // The button does not belong to this review message; the message
            // may be a valid review for another id, so it is left untouched.
            yield* logDecisionFailure("identity", "button-message-mismatch");
            return;
        }

        if (input.action === "approve") {
            if (payload.state === "approved") {
                yield* finalizeMessage(input, "approved");
                return;
            }
            if (payload.state === "rejected") {
                yield* finalizeMessage(input, "rejected");
                return;
            }
            const approval: NoteApproval = {
                id: payload.id,
                name: payload.name,
                body: payload.body,
                submittedAt: payload.submittedAt,
            };
            const approved = yield* Effect.result(input.content.approveNote(approval));
            if (Result.isFailure(approved)) {
                // Publication refused (capacity, conflict) or uncertain:
                // controls remain, nothing was finalized, and a retry
                // re-consults the authoritative writer. The owner learns
                // why through an ephemeral followup.
                yield* reportOwner(input, writerRefusalMessage("approve", approved.failure));
                yield* logDecisionFailure(
                    "approve",
                    approved.failure._tag === "Discord.BotStorageError"
                        ? `status-${approved.failure.status ?? "unknown"}`
                        : approved.failure._tag,
                );
                return;
            }
            yield* finalizeMessage(input, "approved");
            return;
        }

        if (payload.state === "rejected") {
            yield* finalizeMessage(input, "rejected");
            return;
        }
        if (payload.state === "approved") {
            yield* finalizeMessage(input, "approved");
            return;
        }
        const rejected = yield* Effect.result(input.content.rejectNote(payload.id));
        if (Result.isFailure(rejected)) {
            yield* reportOwner(input, writerRefusalMessage("reject", rejected.failure));
            yield* logDecisionFailure(
                "reject",
                rejected.failure._tag === "Discord.BotStorageError"
                    ? `status-${rejected.failure.status ?? "unknown"}`
                    : rejected.failure._tag,
            );
            return;
        }
        if (rejected.success === "already-approved") {
            // The durable decision for this id is approval: the message must
            // never display Rejected.
            yield* finalizeMessage(input, "approved");
            return;
        }
        yield* finalizeMessage(input, "rejected");
    });

/**
 * The one component handler for both decision buttons. Denials and invalid
 * targets answer immediately and touch nothing; a valid, authorized click
 * ACKs with type 6 first — via {@link queueJob}, so a failed ACK starts no
 * job — and the decision runs only after Discord confirmed the ACK.
 */
export const noteDecisionHandler = Ix.messageComponent(
    Ix.idStartsWith("note:"),
    Effect.gen(function* () {
        const interaction = yield* Ix.Interaction;
        const data = yield* Ix.MessageComponentData;
        const config: BotConfigService = yield* BotConfig;
        const content: BotContentClientService = yield* BotContentClient;
        const rest: DiscordRestService = yield* DiscordREST;
        const moderation = yield* NoteModeration;

        const memberUserId = interaction.member?.user.id ?? interaction.user?.id;
        const authorized =
            interaction.guild_id === config.serverId &&
            memberUserId === config.userId &&
            interaction.channel_id === config.notesChannelId &&
            interaction.application_id === config.clientId;
        if (!authorized) {
            return ephemeralResponse(PRIVATE_BOT_MESSAGE);
        }

        const parsed = parseNoteCustomId(data.custom_id);
        if (parsed === null || !isSubmissionId(parsed.id)) {
            return ephemeralResponse("That moderation request is not valid.");
        }

        const webhook = parseDiscordWebhookUrl(Redacted.value(config.notesWebhookUrl));
        if (webhook === null || interaction.message === undefined) {
            return ephemeralResponse("Moderation is not configured correctly; check the bot logs.");
        }

        const input: DecisionJobInput = {
            rest,
            interactionToken: interaction.token,
            content,
            config,
            webhook,
            action: parsed.action,
            submissionId: parsed.id,
            sourceMessageId: interaction.message.id,
        };
        yield* queueJob(moderation.withPermit(decisionJob(input)));
        return deferredComponentAck;
    }),
);

/** A decision id must be exactly one canonical submission id. */
const isSubmissionId = Schema.is(NoteSubmissionId);

/**
 * Startup verification of the notes webhook: it must parse, exist, be
 * application-owned by this bot, and target the configured review channel.
 * Any mismatch fails startup with a sanitized reason — no secret values.
 */
export const verifyNotesWebhook: Effect.Effect<void, NotesWebhookError, BotConfig | DiscordREST> =
    Effect.gen(function* () {
        const config: BotConfigService = yield* BotConfig;
        const rest: DiscordRestService = yield* DiscordREST;
        const webhook = parseDiscordWebhookUrl(Redacted.value(config.notesWebhookUrl));
        if (webhook === null) {
            return yield* new NotesWebhookError({
                field: "DISCORD_NOTES_WEBHOOK_URL",
                reason: "unparseable",
            });
        }
        if (webhook.id !== config.notesWebhookId) {
            return yield* new NotesWebhookError({
                field: "DISCORD_NOTES_WEBHOOK_ID",
                reason: "url-id-mismatch",
            });
        }
        const fetched = yield* Effect.result(rest.getWebhookByToken(webhook.id, webhook.token));
        if (Result.isFailure(fetched)) {
            return yield* new NotesWebhookError({
                field: "DISCORD_NOTES_WEBHOOK_URL",
                reason: "unreachable",
            });
        }
        const webhookResponse = fetched.success;
        const applicationOwned =
            webhookResponse.type === 1 &&
            "application_id" in webhookResponse &&
            webhookResponse.application_id === config.clientId;
        if (!applicationOwned) {
            return yield* new NotesWebhookError({
                field: "DISCORD_NOTES_WEBHOOK_URL",
                reason: "not-application-owned",
            });
        }
        if (webhookResponse.channel_id !== config.notesChannelId) {
            return yield* new NotesWebhookError({
                field: "DISCORD_NOTES_CHANNEL_ID",
                reason: "channel-mismatch",
            });
        }
        if (!("guild_id" in webhookResponse) || webhookResponse.guild_id !== config.serverId) {
            return yield* new NotesWebhookError({
                field: "DISCORD_SERVER_ID",
                reason: "guild-mismatch",
            });
        }
    });
