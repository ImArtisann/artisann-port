import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
    NoteSubmissionAccepted,
    NOTE_BODY_BYTES_MAX,
    TURNSTILE_ACTION,
    decodeNoteSubmission,
    discordWebhookExecutionUrl,
    noteReviewMessage,
    parseDiscordWebhookUrl,
    type NoteSubmissionInput,
} from "./notes.ts";
import type { NoteSubmission } from "./notes.ts";
import { NoteSubmissionError } from "./api-errors.ts";

export interface NotesRateLimitBinding {
    limit(options: { key: string }): Promise<Schema.Json>;
}

/** Native Worker fields used to construct the notes domain capabilities. */
export interface NotesWorkerEnv {
    /** Secret: application-owned webhook execution URL for the review channel. */
    readonly DISCORD_NOTES_WEBHOOK_URL: string;
    /** Secret: Turnstile server-side key. */
    readonly TURNSTILE_SECRET_KEY: string;
    /** The private review channel the webhook must land in. */
    readonly DISCORD_NOTES_CHANNEL_ID: string;
    /** The only website origin allowed to submit (localhost dev allowed too). */
    readonly WEBSITE_ORIGIN: string;
    /** Edge rate limiter; absent or failing means the route is unavailable. */
    readonly NOTES_RATE_LIMIT: NotesRateLimitBinding;
}

export interface NotesRateLimitService {
    readonly binding: NotesRateLimitBinding;
}

export class NotesRateLimit extends Context.Service<NotesRateLimit, NotesRateLimitService>()(
    "@artisann-port/presence/NotesRateLimit",
) {}

export interface NotesConfigService {
    readonly discordNotesWebhookUrl: Redacted.Redacted<string>;
    readonly turnstileSecretKey: Redacted.Redacted<string>;
    readonly discordNotesChannelId: string;
    readonly websiteOrigin: string;
}

export class NotesConfig extends Context.Service<NotesConfig, NotesConfigService>()(
    "@artisann-port/presence/NotesConfig",
) {}

export interface NotesSubmissionContext {
    readonly origin: string | null;
    readonly ip: string | null;
}

export interface NotesServiceContract {
    readonly submit: (
        raw: NoteSubmissionInput,
        context: NotesSubmissionContext,
    ) => Effect.Effect<NoteSubmissionAccepted, NoteSubmissionError>;
}

export class NotesService extends Context.Service<NotesService, NotesServiceContract>()(
    "@artisann-port/presence/NotesService",
) {}

const TurnstileResponse = Schema.Struct({
    success: Schema.Boolean,
    hostname: Schema.optionalKey(Schema.String),
    action: Schema.optionalKey(Schema.String),
});
const decodeTurnstileResponseDocument = Schema.decodeUnknownEffect(
    Schema.fromJsonString(TurnstileResponse),
    { onExcessProperty: "ignore" },
);
const ExecutedMessage = Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[0-9]{17,20}$/u)),
    channel_id: Schema.String.check(Schema.isPattern(/^[0-9]{17,20}$/u)),
});
const decodeExecutedMessageDocument = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ExecutedMessage),
    { onExcessProperty: "ignore" },
);
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface TurnstileRequestBody {
    readonly secret: string;
    readonly response: string;
    readonly remoteip?: string;
}

function turnstileRequestBody(
    secret: string,
    token: string,
    remoteIp: string | null,
): TurnstileRequestBody {
    return remoteIp === null
        ? { secret, response: token }
        : { secret, response: token, remoteip: remoteIp };
}

const verifyTurnstile = Effect.fn("Notes.verifyTurnstile")(function* (
    token: string,
    remoteIp: string | null,
    secret: string,
    websiteOrigin: string,
) {
    const hostname = yield* Effect.try({
        try: () => new URL(websiteOrigin).hostname,
        catch: () => "bad-website-origin" as const,
    });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
        .post(SITEVERIFY_URL, {
            acceptJson: true,
            body: HttpBody.jsonUnsafe(turnstileRequestBody(secret, token, remoteIp)),
        })
        .pipe(Effect.mapError(() => "siteverify-unreachable" as const));
    if (response.status >= 300) return yield* Effect.fail("siteverify-status" as const);
    const result = yield* response.text.pipe(
        Effect.flatMap(decodeTurnstileResponseDocument),
        Effect.mapError(() => "siteverify-shape" as const),
    );
    return (
        result.success === true &&
        result.hostname === hostname &&
        result.action === TURNSTILE_ACTION
    );
});

const deliverReviewMessage = Effect.fn("Notes.deliverReview")(function* (
    note: NoteSubmission,
    webhookUrl: string,
    channelId: string,
) {
    const payload = noteReviewMessage({
        v: 1,
        id: note.id,
        name: note.name,
        body: note.body,
        submittedAt: DateTime.formatIso(yield* DateTime.now),
        state: "pending",
    });
    if (payload === null) return yield* Effect.fail("note-shape" as const);
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
        .post(webhookUrl, {
            acceptJson: true,
            urlParams: { wait: "true", with_components: "true" },
            body: HttpBody.jsonUnsafe(payload),
        })
        .pipe(Effect.mapError(() => "webhook-unreachable" as const));
    if (response.status >= 300) return yield* Effect.fail("webhook-status" as const);
    const message = yield* response.text.pipe(
        Effect.flatMap(decodeExecutedMessageDocument),
        Effect.mapError(() => "webhook-shape" as const),
    );
    if (message.channel_id !== channelId) return yield* Effect.fail("webhook-channel" as const);
    return message.id;
});

const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u;

function isLocalOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    } catch {
        return false;
    }
}

/** Pure origin rule shared by the notes service and the RPC request boundary. */
export function originAllowed(origin: string, websiteOrigin: string): boolean {
    if (origin === websiteOrigin) return true;
    return isLocalOrigin(websiteOrigin) && LOCAL_ORIGIN_PATTERN.test(origin);
}

function rateLimitKey(ip: string | null, origin: string, websiteOrigin: string): string | null {
    if (ip !== null && ip !== "" && ip === ip.trim() && ip.length <= 64) {
        return `note:${ip}`;
    }
    return isLocalOrigin(websiteOrigin) && LOCAL_ORIGIN_PATTERN.test(origin)
        ? "note:local-dev"
        : null;
}

const RateLimitResult = Schema.Struct({ success: Schema.Boolean });
const decodeRateLimitResult = Schema.decodeUnknownEffect(RateLimitResult, {
    onExcessProperty: "ignore",
});

export const NotesLive: Layer.Layer<
    NotesService,
    never,
    NotesConfig | NotesRateLimit | HttpClient.HttpClient
> = Layer.effect(
    NotesService,
    Effect.gen(function* () {
        const config = yield* NotesConfig;
        const limiter = yield* NotesRateLimit;
        const client = yield* HttpClient.HttpClient;
        const submit = Effect.fn("Notes.submit")(function* (
            raw: NoteSubmissionInput,
            context: NotesSubmissionContext,
        ) {
            if (context.origin === null || !originAllowed(context.origin, config.websiteOrigin)) {
                return yield* new NoteSubmissionError({ reason: "forbidden" });
            }
            const rawBytes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                raw,
            ).pipe(
                Effect.map((document) => new TextEncoder().encode(document).byteLength),
                Effect.mapError(() => new NoteSubmissionError({ reason: "invalid" })),
            );
            if (rawBytes > NOTE_BODY_BYTES_MAX) {
                return yield* new NoteSubmissionError({ reason: "invalid" });
            }
            const submission = yield* decodeNoteSubmission(raw).pipe(
                Effect.mapError(() => new NoteSubmissionError({ reason: "invalid" })),
            );
            const key = rateLimitKey(context.ip, context.origin, config.websiteOrigin);
            if (key === null) return yield* new NoteSubmissionError({ reason: "forbidden" });
            const limited = yield* Effect.tryPromise({
                try: () => limiter.binding.limit({ key }),
                catch: () => new NoteSubmissionError({ reason: "unavailable" }),
            }).pipe(
                Effect.flatMap(decodeRateLimitResult),
                Effect.mapError(() => new NoteSubmissionError({ reason: "unavailable" })),
            );
            if (!limited.success) {
                return yield* new NoteSubmissionError({ reason: "throttled" });
            }
            const verified = yield* verifyTurnstile(
                submission.turnstileToken,
                context.ip,
                Redacted.value(config.turnstileSecretKey),
                config.websiteOrigin,
            ).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.timeout("10 seconds"),
                Effect.option,
            );
            if (Option.isNone(verified)) {
                return yield* new NoteSubmissionError({ reason: "unavailable" });
            }
            if (!verified.value) return yield* new NoteSubmissionError({ reason: "forbidden" });
            const webhook = parseDiscordWebhookUrl(Redacted.value(config.discordNotesWebhookUrl));
            if (webhook === null) {
                return yield* new NoteSubmissionError({ reason: "unavailable" });
            }
            const delivered = yield* deliverReviewMessage(
                submission,
                discordWebhookExecutionUrl(webhook),
                config.discordNotesChannelId,
            ).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.timeout("15 seconds"),
                Effect.option,
            );
            if (Option.isNone(delivered)) {
                return yield* new NoteSubmissionError({ reason: "unavailable" });
            }
            return { status: "pending", id: submission.id } satisfies NoteSubmissionAccepted;
        });
        return NotesService.of({ submit });
    }),
);
