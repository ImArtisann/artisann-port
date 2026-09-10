/**
 * The visitor-note contract, shared by everyone who touches a note:
 *
 * - the website composer, which submits and decodes responses;
 * - the presence Worker, which verifies, throttles and forwards submissions;
 * - the Discord bot, which moderates them through review-message buttons.
 *
 * This module is browser-safe: schemas, normalization, the versioned
 * review-payload codec, message-shape builders and pure URL parsing only —
 * no credentials, no runtime client, no Worker-only imports. Every interface
 * is the same-name twin of its schema, following `schema.ts` and `content.ts`.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
    EntryId,
    IsoTimestamp,
    MAX_NOTE_BODY,
    normalizeNoteName,
    normalizeNoteText,
} from "./content.ts";

/** Visitor display-name limit; a blank or missing name is anonymous. */
export const NOTE_NAME_MAX = 40;
/** Visitor note body limit in characters, shared by composer/Worker/bot. */
export const NOTE_BODY_MAX = MAX_NOTE_BODY;
/** Hard byte cap for one canonical submission input at the service boundary. */
export const NOTE_BODY_BYTES_MAX = 4096;
/** Turnstile `action` the Worker requires on every siteverify response. */
export const TURNSTILE_ACTION = "submit-note";
/** Version prefix every review-payload footer carries. */
export const NOTE_PAYLOAD_PREFIX = "note.v1:";

/**
 * A stable, non-authoritative submission id: exactly 32 lowercase hex
 * characters. Length, trim and pattern are all schema constraints, so the
 * decoder itself cannot be bypassed with a padded or newline-suffixed id.
 */
export const NoteSubmissionId = Schema.String.check(
    Schema.makeFilter<string>(
        (value) =>
            value.length === 32 && value === value.trim() && /^[0-9a-f]{32}$/u.test(value)
                ? undefined
                : false,
        { identifier: "Presence.NoteSubmissionId" },
    ),
);

export type NoteSubmissionId = Schema.Schema.Type<typeof NoteSubmissionId>;

const boundedName = Schema.String.check(
    Schema.isMaxLength(NOTE_NAME_MAX),
    Schema.makeFilter<string>((value) => (normalizeNoteText(value) === null ? false : undefined), {
        identifier: "Presence.NoteName",
    }),
);

const boundedBody = Schema.String.check(
    Schema.isMaxLength(NOTE_BODY_MAX),
    Schema.makeFilter<string>((value) => (normalizeNoteText(value) === null ? false : undefined), {
        identifier: "Presence.NoteBody",
    }),
);

/**
 * The strict canonical submission: name is `null` (anonymous) or a
 * non-blank trimmed name, body is a non-blank trimmed note.
 */
export const NoteSubmission = Schema.Struct({
    id: NoteSubmissionId,
    name: Schema.NullOr(boundedName),
    body: boundedBody,
    turnstileToken: Schema.String.check(Schema.isMaxLength(2048)),
});

export type NoteSubmission = typeof NoteSubmission.Type;

/** The wire shape the Worker accepts before normalization. */
export const RawNoteSubmission = Schema.Struct({
    id: NoteSubmissionId,
    name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    body: Schema.String,
    turnstileToken: Schema.String.check(Schema.isMaxLength(2048)),
});

export type RawNoteSubmission = typeof RawNoteSubmission.Type;

/** Raw JSON input accepted before strict note submission decoding. */
export type NoteSubmissionInput = Schema.Json | RawNoteSubmission;

const decodeRawSubmission = Schema.decodeUnknownEffect(RawNoteSubmission, {
    onExcessProperty: "error",
});
const canonicalSubmission = Schema.decodeUnknownEffect(NoteSubmission, {
    onExcessProperty: "error",
});

type DecodedRawSubmission = Schema.Schema.Type<typeof RawNoteSubmission>;
const normalizeSubmission = (raw: DecodedRawSubmission) =>
    canonicalSubmission({
        id: raw.id,
        name: raw.name === null || raw.name === undefined ? null : normalizeNoteName(raw.name),
        body: normalizeNoteText(raw.body),
        turnstileToken: raw.turnstileToken,
    });

/**
 * The one public submission decoder: raw wire decode (unknown fields
 * rejected), shared normalization (blank/absent name becomes `null`, body
 * trimmed), then canonical validation — all in one step, one error type.
 */
export const decodeNoteSubmission = (
    input: NoteSubmissionInput,
): Effect.Effect<NoteSubmission, Schema.SchemaError> =>
    Effect.flatMap(decodeRawSubmission(input), normalizeSubmission);

/** Accepted submission: pending moderation. Discord is the pending inbox. */
export const NoteSubmissionAccepted = Schema.Struct({
    status: Schema.Literals(["pending"]),
    id: NoteSubmissionId,
});

export type NoteSubmissionAccepted = typeof NoteSubmissionAccepted.Type;

/**
 * Generate one submission id: 32 lowercase hex characters, random once per
 * composer submission and retained across retries of the same note.
 */
export function newSubmissionId(): NoteSubmissionId {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

// ---------------------------------------------------------------------------
// Review payload: the versioned, lossless message codec
// ---------------------------------------------------------------------------

/** Moderation lifecycle of one review message, journaled in its own footer. */
export const NotePayloadState = Schema.Literals(["pending", "approved", "rejected"]);

export type NotePayloadState = typeof NotePayloadState.Type;

/**
 * The canonical note text, encoded losslessly into the review message's
 * footer. Discord never reformats the footer, so approval stores the
 * submitted text — not Markdown escape characters. The footer status is
 * presentation only: the durable intent journal is the authoritative
 * content writer, never this message alone.
 */
export const NoteReviewPayload = Schema.Struct({
    v: Schema.Literals([1]),
    id: EntryId,
    name: Schema.NullOr(boundedName),
    body: boundedBody,
    submittedAt: IsoTimestamp,
    state: NotePayloadState,
});

export type NoteReviewPayload = typeof NoteReviewPayload.Type;

const NoteReviewPayloadDocument = Schema.fromJsonString(NoteReviewPayload);
const decodePayloadText = Schema.decodeUnknownEffect(NoteReviewPayloadDocument, {
    onExcessProperty: "error",
});

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(encoded: string): Uint8Array {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/**
 * Encode the payload into its footer form (`note.v1:<base64url JSON>`).
 * The JSON text is validated by decoding it back through the schema, so an
 * out-of-contract payload never becomes a footer. Returns `null` then.
 */
export function encodeNotePayload(payload: NoteReviewPayload): string | null {
    try {
        const jsonText = JSON.stringify(payload);
        const validated = Effect.runSyncExit(decodePayloadText(jsonText));
        if (Exit.isFailure(validated)) return null;
        return NOTE_PAYLOAD_PREFIX + bytesToBase64Url(new TextEncoder().encode(jsonText));
    } catch {
        return null;
    }
}

/**
 * Decode a footer back into the payload, or `null` on any mismatch: wrong
 * prefix, bad base64, malformed JSON, unknown version/state or field
 * violations. Untrusted input becomes `null` for fail-closed handling,
 * never an exception.
 */
export function decodeNotePayload(encoded: string): NoteReviewPayload | null {
    if (!encoded.startsWith(NOTE_PAYLOAD_PREFIX)) return null;
    try {
        const jsonText = new TextDecoder().decode(
            base64UrlToBytes(encoded.slice(NOTE_PAYLOAD_PREFIX.length)),
        );
        const decoded = Effect.runSyncExit(decodePayloadText(jsonText));
        return Exit.isSuccess(decoded) ? decoded.value : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Presentation: escaping and message shapes
// ---------------------------------------------------------------------------

/**
 * Escape Discord presentation formatting so visitor text renders as plain
 * text inside embed fields: backslash first, then the markdown characters
 * and the angle brackets that could otherwise form masks or mentions.
 */
export function escapeNoteText(text: string): string {
    let escaped = "";
    for (const character of text) {
        escaped += "\\/`*_~|<>".includes(character) ? `\\${character}` : character;
    }
    return escaped;
}

/** Versioned custom ids for the two decision buttons. */
export function noteApproveCustomId(id: EntryId): string {
    return `note:approve:${id}`;
}

/** Versioned custom ids for the two decision buttons. */
export function noteRejectCustomId(id: EntryId): string {
    return `note:reject:${id}`;
}

const CUSTOM_ID_PATTERN = /^note:(approve|reject):([a-z0-9-]{1,32})$/u;

/** Parse a custom id, or `null` when it is not a valid decision target. */
export function parseNoteCustomId(
    customId: string,
): { action: "approve" | "reject"; id: string } | null {
    const match = CUSTOM_ID_PATTERN.exec(customId);
    if (match === null) return null;
    const action = match[1];
    const id = match[2];
    if (action !== "approve" && action !== "reject") return null;
    if (id === undefined) return null;
    return { action, id };
}

/** One Discord action row with the Ok/Delete pair. */
export interface NoteActionRow {
    readonly type: 1;
    readonly components: ReadonlyArray<{
        readonly type: 2;
        readonly style: 3 | 4;
        readonly label: string;
        readonly custom_id: string;
    }>;
}

/** Embed field — the plain subset the Worker and bot both send. */
export interface NoteEmbedField {
    readonly name: string;
    readonly value: string;
    readonly inline?: boolean;
}

/** Embed — the plain subset the Worker and bot both send. */
export interface NoteEmbed {
    readonly description?: string;
    readonly fields?: ReadonlyArray<NoteEmbedField>;
    readonly footer?: { readonly text: string };
    readonly timestamp?: string;
    readonly color?: number;
}

/** The pending review message body: embed plus the two buttons. */
export interface NoteReviewMessage {
    readonly embeds: ReadonlyArray<NoteEmbed>;
    readonly components: ReadonlyArray<NoteActionRow>;
    readonly allowed_mentions: { readonly parse: ReadonlyArray<never> };
}

/**
 * Build the review message for one pending payload. Visitor text lives in
 * dedicated embed fields, escaped; the footer carries the lossless codec.
 * The submission id never appears in a control or link.
 */
export function noteReviewMessage(payload: NoteReviewPayload): NoteReviewMessage | null {
    const footer = encodeNotePayload(payload);
    if (footer === null) return null;
    return {
        embeds: [
            {
                description: escapeNoteText(payload.body),
                fields: [
                    {
                        name: "Submitted by",
                        value: payload.name === null ? "Anonymous" : escapeNoteText(payload.name),
                        inline: true,
                    },
                    { name: "Note id", value: payload.id, inline: true },
                    {
                        name: "Status",
                        value: payload.state === "pending" ? "Pending review" : payload.state,
                    },
                ],
                footer: { text: footer },
                timestamp: payload.submittedAt,
                color: 0x5865f2,
            },
        ],
        components:
            payload.state === "pending"
                ? [
                      {
                          type: 1,
                          components: [
                              {
                                  type: 2,
                                  style: 3,
                                  label: "Ok",
                                  custom_id: noteApproveCustomId(payload.id),
                              },
                              {
                                  type: 2,
                                  style: 4,
                                  label: "Delete",
                                  custom_id: noteRejectCustomId(payload.id),
                              },
                          ],
                      },
                  ]
                : [],
        allowed_mentions: { parse: [] },
    };
}

/** A finalized message: status text, both buttons removed, no embeds. */
export interface NoteFinalizedMessage {
    readonly content: string;
    readonly embeds: ReadonlyArray<never>;
    readonly components: ReadonlyArray<never>;
    readonly allowed_mentions: { readonly parse: ReadonlyArray<never> };
}

const FINALIZED_LABELS = {
    approved: (id: string) => `Note ${id} approved.`,
    rejected: (id: string) => `Note ${id} rejected.`,
    malformed: (id: string) => `Review message for ${id} is malformed and cannot be processed.`,
} as const;

/** Build the finalized replacement for one decision outcome. */
export function noteFinalizedMessage(
    outcome: keyof typeof FINALIZED_LABELS,
    id: string,
): NoteFinalizedMessage {
    return {
        content: FINALIZED_LABELS[outcome](id),
        embeds: [],
        components: [],
        allowed_mentions: { parse: [] },
    };
}

/** The JSON body for executing the notes webhook with a confirmed send. */
export type NoteWebhookRequestBody = NoteReviewMessage | NoteFinalizedMessage;

// ---------------------------------------------------------------------------
// Webhook URL parsing (secret-bearing; parse only, never log)
// ---------------------------------------------------------------------------

/** The id and token encoded in a Discord webhook execution URL. */
export interface ParsedWebhookUrl {
    readonly id: string;
    readonly token: string;
}

const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

/**
 * Hosts Discord serves webhook execution URLs from. The host is validated
 * rather than rewritten: a URL pointing somewhere else is a misconfiguration,
 * not something to normalize into a Discord request.
 */
const DISCORD_WEBHOOK_HOSTS: readonly string[] = ["discord.com", "discordapp.com"];

/**
 * Parse `https://discord.com/api/webhooks/<id>/<token>`. Returns `null` on
 * any mismatch; the token is never logged or exposed by the caller.
 */
export function parseDiscordWebhookUrl(url: string): ParsedWebhookUrl | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.search !== "") {
        return null;
    }
    if (parsed.hash !== "" || !DISCORD_WEBHOOK_HOSTS.includes(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    if (parts.length !== 4 || parts[0] !== "api" || parts[1] !== "webhooks") return null;
    const id = parts[2];
    const token = parts[3];
    if (id === undefined || token === undefined) return null;
    if (!/^[0-9]{17,20}$/u.test(id) || !WEBHOOK_TOKEN_PATTERN.test(token)) return null;
    return { id, token };
}

/** Recompose an execution URL from parsed parts (never embeds into messages). */
export function discordWebhookExecutionUrl(parsed: ParsedWebhookUrl): string {
    return `https://discord.com/api/webhooks/${parsed.id}/${parsed.token}`;
}
