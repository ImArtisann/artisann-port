/**
 * Behavioral checks for note moderation: authorization, source-message
 * retrieval, finalization, and the uncertainty boundary (opposing clicks,
 * duplicates, deleted messages, writer refusals).
 *
 * Discord is exercised through the real `DiscordRESTLive` stack — rate
 * limiting, config and HTTP transport are the production layers; only the
 * transport fixture is replaced, so every request and response crosses the
 * genuine dfx schema boundary. Content is a complete in-memory fake of the
 * split `BotContentClient` contract whose non-moderation methods die on
 * unexpected use.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { DiscordConfig, DiscordRESTLive, MemoryRateLimitStoreLive } from "dfx";
import type { Discord } from "dfx";
import { Ix } from "dfx";
import {
    decodeNotePayload,
    encodeNotePayload,
    noteFinalizedMessage,
} from "@artisann-port/presence/notes";
import { BotConfig } from "../src/config.ts";
import type { BotConfigService } from "../src/config.ts";
import { BotStorageError, ContentValidationError } from "../src/rpc-client.ts";
import { BotContentClient } from "../src/content-client.ts";
import type { BotContentClientService } from "../src/content-client.ts";
import { NoteModeration, noteDecisionHandler, verifyNotesWebhook } from "../src/notes.ts";
import { PendingInteractionJob, deferredComponentAck } from "../src/interaction-jobs.ts";

// ---------------------------------------------------------------------------
// Fixture ids and shared values
// ---------------------------------------------------------------------------

const CLIENT_ID = "111111111111111111";
const SERVER_ID = "222222222222222222";
const OWNER_ID = "333333333333333333";
const NOTES_CHANNEL_ID = "444444444444444444";
const WEBHOOK_ID = "555555555555555555";
const WEBHOOK_TOKEN = "webhook-token";
const SOURCE_MESSAGE_ID = "1234567890123456789";
const INTERACTION_ID = "999999999999999999";
const NOTE_ID = "a".repeat(32);

const reviewPayload = (state: "pending" | "approved" | "rejected") => ({
    v: 1 as const,
    id: NOTE_ID,
    name: "Vis Itor",
    body: "Hello *world* — nice site!",
    submittedAt: "2026-09-08T00:00:00.000Z",
    state,
});

/** The wire JSON the transport answers webhook-message reads with. */
const reviewMessageJson = (footer: string) => ({
    id: SOURCE_MESSAGE_ID,
    channel_id: NOTES_CHANNEL_ID,
    author: {
        id: WEBHOOK_ID,
        username: "Notes",
        discriminator: "0",
        avatar: null,
        global_name: null,
        public_flags: 0,
        flags: 0,
        primary_guild: null,
    },
    content: "",
    timestamp: "2026-09-08T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mention_roles: [],
    mentions: [],
    attachments: [],
    embeds: [{ footer: { text: footer } }],
    pinned: false,
    type: 0,
    flags: 0,
    webhook_id: WEBHOOK_ID,
    application_id: CLIENT_ID,
    components: [
        {
            type: 1,
            id: 1,
            components: [
                {
                    type: 2,
                    id: 2,
                    style: 3,
                    label: "Approve",
                    custom_id: `note:approve:${NOTE_ID}`,
                },
                {
                    type: 2,
                    id: 3,
                    style: 4,
                    label: "Reject",
                    custom_id: `note:reject:${NOTE_ID}`,
                },
            ],
        },
    ],
});

const WebhookUpdate = Schema.Struct({
    content: Schema.optional(Schema.String),
    components: Schema.optional(Schema.Array(Schema.Unknown)),
    embeds: Schema.optional(Schema.Array(Schema.Unknown)),
    flags: Schema.optional(Schema.Finite),
    allowed_mentions: Schema.optional(Schema.Struct({ parse: Schema.Array(Schema.String) })),
});

type WebhookUpdate = Schema.Schema.Type<typeof WebhookUpdate>;
const decodeWebhookUpdate = Schema.decodeUnknownSync(Schema.fromJsonString(WebhookUpdate));

interface WebhookFixture {
    readonly id: string;
    readonly type: number;
    readonly application_id: string | null;
    readonly channel_id: string;
    readonly guild_id: string;
    readonly name: string;
    readonly avatar: string | null;
}

type RestResponseBody =
    | ReturnType<typeof reviewMessageJson>
    | WebhookFixture
    | { readonly message: string };

/**
 * The interaction's attached message. `message` on a component interaction
 * is discord-api-types' `APIMessage`, which is a different (mutable) type
 * from dfx's REST `MessageResponse`, so the fixture is typed from the
 * interaction itself rather than shared with the wire JSON above.
 */
const interactionMessage = (
    footer: string,
): NonNullable<Discord.APIMessageComponentInteraction["message"]> => ({
    id: SOURCE_MESSAGE_ID,
    channel_id: NOTES_CHANNEL_ID,
    author: {
        id: WEBHOOK_ID,
        username: "Notes",
        discriminator: "0",
        avatar: null,
        global_name: null,
    },
    content: "",
    timestamp: "2026-09-08T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mention_roles: [],
    mentions: [],
    attachments: [],
    embeds: [{ footer: { text: footer } }],
    pinned: false,
    type: 0,
    webhook_id: WEBHOOK_ID,
    application_id: CLIENT_ID,
    components: [],
});

/**
 * SAFETY: `locale` is discord-api-types' `Locale` string enum and that
 * package is not a direct dependency of this workspace; "en-US" is the exact
 * wire value Discord sends, and nothing in these tests reads the field.
 */
const INTERACTION_LOCALE = "en-US" as Discord.APIMessageComponentInteraction["locale"];

// ---------------------------------------------------------------------------
// Real REST stack over a scripted transport
// ---------------------------------------------------------------------------

interface TransportState {
    /** The review message the transport answers `GET .../messages/:id` with. */
    message: ReturnType<typeof reviewMessageJson> | null;
    /** The webhook `GET /webhooks/:id/:token` answers with, or `null` for 404. */
    webhook: WebhookFixture | null;
    /** Contents of every PATCHed webhook message update. */
    readonly patched: Array<WebhookUpdate>;
    /** Contents of every ephemeral owner followup. */
    readonly followups: Array<WebhookUpdate>;
    /** How many source-message fetches were made. */
    fetched: number;
}

const makeTransportLayer = (state: TransportState) =>
    Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
            const url = new URL(request.url);
            const respond = (status: number, body: RestResponseBody) =>
                Effect.succeed(
                    HttpClientResponse.fromWeb(request, Response.json(body, { status })),
                );
            // dfx targets the versioned REST base (`/api/v10/...`), so the
            // fixture matches the webhook suffix rather than a fixed prefix.
            const webhookPath = `/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
            const messagePath = `${webhookPath}/messages/${SOURCE_MESSAGE_ID}`;
            const byteBody = (body: typeof request.body): string | null =>
                body instanceof HttpBody.Uint8Array ? new TextDecoder().decode(body.body) : null;
            if (request.method === "GET" && url.pathname.endsWith(messagePath)) {
                state.fetched += 1;
                return state.message === null
                    ? respond(404, { message: "Unknown Message" })
                    : respond(200, state.message);
            }
            if (request.method === "PATCH" && url.pathname.endsWith(messagePath)) {
                const patchedBody = byteBody(request.body);
                if (patchedBody === null) {
                    return Effect.die(new Error("PATCH body was not a byte array"));
                }
                state.patched.push(decodeWebhookUpdate(patchedBody));
                return state.message === null
                    ? respond(404, { message: "Unknown Message" })
                    : respond(200, state.message);
            }
            if (request.method === "GET" && url.pathname.endsWith(webhookPath)) {
                return state.webhook === null
                    ? respond(404, { message: "Unknown Webhook" })
                    : respond(200, state.webhook);
            }
            if (
                request.method === "POST" &&
                url.pathname.endsWith(`/webhooks/${CLIENT_ID}/interaction-token`)
            ) {
                const followupBody = byteBody(request.body);
                if (followupBody === null) {
                    return Effect.die(new Error("followup body was not a byte array"));
                }
                state.followups.push(decodeWebhookUpdate(followupBody));
                return respond(200, reviewMessageJson(""));
            }
            return Effect.die(new Error(`unexpected ${request.method} ${url.pathname}`));
        }),
    );

const restLayer = (state: TransportState) =>
    DiscordRESTLive.pipe(
        Layer.provide(DiscordConfig.layer({ token: Redacted.make("config-token-for-tests") })),
        Layer.provide(MemoryRateLimitStoreLive),
        Layer.provide(makeTransportLayer(state)),
    );

// ---------------------------------------------------------------------------
// Content client fake: complete contract, unexpected use dies
// ---------------------------------------------------------------------------

interface ContentScript {
    approve: () => Effect.Effect<
        "approved" | "already-approved",
        BotStorageError | ContentValidationError
    >;
    reject: () => Effect.Effect<
        "rejected" | "already-rejected" | "already-approved",
        BotStorageError
    >;
    readonly approvals: Array<{ id: string; name: string | null; body: string }>;
    readonly rejections: Array<string>;
}

const makeContentClient = (script: ContentScript): BotContentClientService => ({
    loadContent: Effect.die("unexpected loadContent in notes test"),
    updateContent: () => Effect.die("unexpected updateContent in notes test"),
    approveNote: (approval) => {
        script.approvals.push({
            id: approval.id,
            name: approval.name,
            body: approval.body,
        });
        return script.approve();
    },
    rejectNote: (id) => {
        script.rejections.push(id);
        return script.reject();
    },
});

const approveScript = (): ContentScript => ({
    approve: () => Effect.succeed("approved"),
    reject: () => Effect.succeed("rejected"),
    approvals: [],
    rejections: [],
});

const failingContentScript = (operation: "approve" | "reject", status: number): ContentScript => ({
    ...approveScript(),
    approve: () =>
        operation === "approve"
            ? Effect.fail(new BotStorageError({ operation: "approve", status, reason: "test" }))
            : Effect.succeed("approved"),
    reject: () =>
        operation === "reject"
            ? Effect.fail(new BotStorageError({ operation: "reject", status, reason: "test" }))
            : Effect.succeed("rejected"),
});

// ---------------------------------------------------------------------------
// Fully typed interaction fixtures
// ---------------------------------------------------------------------------

const makeConfig = (): BotConfigService => ({
    token: Redacted.make("bot-token"),
    clientId: CLIENT_ID,
    serverId: SERVER_ID,
    userId: OWNER_ID,
    notesChannelId: NOTES_CHANNEL_ID,
    notesWebhookId: WEBHOOK_ID,
    notesWebhookUrl: Redacted.make(
        `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
    ),
    portfolioApiUrl: "https://presence.artisann.dev",
    contentWriterToken: Redacted.make("writer-token"),
    assetsHost: "assets.artisann.dev",
});

const makeInteraction = (
    data: Discord.APIMessageComponentInteractionData,
    overrides?: {
        readonly guildId?: string;
        readonly userId?: string;
        readonly channelId?: string;
        readonly applicationId?: string;
    },
): Discord.APIInteraction => ({
    id: INTERACTION_ID,
    application_id: overrides?.applicationId ?? CLIENT_ID,
    type: 3,
    token: "interaction-token",
    version: 1,
    guild_id: overrides?.guildId ?? SERVER_ID,
    channel_id: overrides?.channelId ?? NOTES_CHANNEL_ID,
    channel: { id: overrides?.channelId ?? NOTES_CHANNEL_ID, type: 0 },
    user: {
        id: overrides?.userId ?? OWNER_ID,
        username: "owner",
        discriminator: "0",
        avatar: null,
        global_name: null,
    },
    data,
    message: interactionMessage(encodeNotePayload(reviewPayload("pending")) ?? ""),
    app_permissions: "0",
    locale: INTERACTION_LOCALE,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10485760,
});

const buttonData = (customId: string): Discord.APIMessageComponentInteractionData => ({
    custom_id: customId,
    component_type: 2,
});

// ---------------------------------------------------------------------------
// Running the handler the way runIx would
// ---------------------------------------------------------------------------

const makeModeration = () => {
    const semaphore = Semaphore.makeUnsafe(1);
    return {
        withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => semaphore.withPermits(1)(effect),
    };
};

const runHandler = (
    state: TransportState,
    content: BotContentClientService,
    interaction: Discord.APIInteraction,
    data: Discord.APIMessageComponentInteractionData,
) => {
    const pendingRef = Ref.makeUnsafe(Option.none<Effect.Effect<void>>());
    const services = Context.make(BotConfig, makeConfig()).pipe(
        (context) => Context.add(context, BotContentClient, content),
        (context) => Context.add(context, NoteModeration, makeModeration()),
        (context) => Context.add(context, PendingInteractionJob, { ref: pendingRef }),
        (context) => Context.add(context, Ix.Interaction, interaction),
        (context) => Context.add(context, Ix.MessageComponentData, data),
    );
    const response = Effect.runPromiseExit(
        noteDecisionHandler.handle.pipe(Effect.provide(services), Effect.provide(restLayer(state))),
    );
    return { response, pendingRef };
};

const runQueuedJob = (pendingRef: Ref.Ref<Option.Option<Effect.Effect<void>>>) => {
    const queued = Effect.runSync(Ref.get(pendingRef));
    expect(Option.isSome(queued)).toBe(true);
    if (Option.isNone(queued)) throw new Error("no job was queued");
    return Effect.runPromiseExit(queued.value);
};

const approveInteraction = () => makeInteraction(buttonData(`note:approve:${NOTE_ID}`));

// ---------------------------------------------------------------------------
// Authorization and routing
// ---------------------------------------------------------------------------

describe("note decision authorization", () => {
    it("denies a non-owner with an immediate ephemeral response and no job", async () => {
        const state: TransportState = {
            message: null,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData(`note:approve:${NOTE_ID}`), {
                userId: "444444444444444445",
            }),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        const settled = await response;
        expect(settled._tag).toBe("Success");
        if (settled._tag === "Success") {
            expect(settled.value.type).toBe(4);
        }
        expect(Option.isNone(Effect.runSync(Ref.get(pendingRef)))).toBe(true);
        expect(script.approvals).toHaveLength(0);
        expect(state.fetched).toBe(0);
    });

    it("denies a foreign guild, channel or application the same way", async () => {
        for (const overrides of [
            { guildId: "999999999999999999" },
            { channelId: "999999999999999999" },
            { applicationId: "999999999999999999" },
        ]) {
            const state: TransportState = {
                message: null,
                webhook: null,
                patched: [],
                followups: [],
                fetched: 0,
            };
            const script = approveScript();
            const { response, pendingRef } = runHandler(
                state,
                makeContentClient(script),
                makeInteraction(buttonData(`note:approve:${NOTE_ID}`), overrides),
                buttonData(`note:approve:${NOTE_ID}`),
            );
            const settled = await response;
            if (settled._tag === "Success") expect(settled.value.type).toBe(4);
            expect(Option.isNone(Effect.runSync(Ref.get(pendingRef)))).toBe(true);
            expect(script.approvals).toHaveLength(0);
            expect(state.fetched).toBe(0);
        }
    });

    it("answers an invalid custom id immediately and queues no job", async () => {
        const state: TransportState = {
            message: null,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData("note:approve:not-an-id")),
            buttonData("note:approve:not-an-id"),
        );
        const settled = await response;
        if (settled._tag === "Success") expect(settled.value.type).toBe(4);
        expect(Option.isNone(Effect.runSync(Ref.get(pendingRef)))).toBe(true);
        expect(script.approvals).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Approve and reject decisions
// ---------------------------------------------------------------------------

describe("note decisions", () => {
    it("approves a pending note through the writer and finalizes the message", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        const settled = await response;
        expect(settled._tag === "Success" && settled.value).toEqual(deferredComponentAck);
        const job = await runQueuedJob(pendingRef);
        expect(job._tag).toBe("Success");
        expect(script.approvals).toEqual([
            {
                id: NOTE_ID,
                name: "Vis Itor",
                body: "Hello *world* — nice site!",
            },
        ]);
        expect(state.patched).toHaveLength(1);
        expect(state.patched[0]).toEqual(
            expect.objectContaining({
                content: noteFinalizedMessage("approved", NOTE_ID).content,
                components: [],
            }),
        );
    });

    it("re-approving an already-approved review finalizes without another write", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("approved")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(script.approvals).toHaveLength(0);
        expect(state.patched).toHaveLength(1);
    });

    it("an uncertain or refused approval leaves the controls usable", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = failingContentScript("approve", 503);
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        const job = await runQueuedJob(pendingRef);
        expect(job._tag).toBe("Success");
        expect(state.patched).toHaveLength(0);
        expect(script.approvals).toHaveLength(1);
        expect(state.followups).toHaveLength(1);
    });

    it("rejects a pending note and finalizes without any approval attempt", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData(`note:reject:${NOTE_ID}`)),
            buttonData(`note:reject:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(script.rejections).toEqual([NOTE_ID]);
        expect(script.approvals).toHaveLength(0);
        expect(state.patched[0]).toEqual(
            expect.objectContaining({
                content: noteFinalizedMessage("rejected", NOTE_ID).content,
                components: [],
            }),
        );
    });

    it("a generic reject conflict keeps controls and sends a private error", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = failingContentScript("reject", 409);
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData(`note:reject:${NOTE_ID}`)),
            buttonData(`note:reject:${NOTE_ID}`),
        );
        await response;
        const job = await runQueuedJob(pendingRef);
        expect(job._tag).toBe("Success");
        expect(state.patched).toHaveLength(0);
        expect(state.followups).toEqual([
            expect.objectContaining({
                content:
                    "Publication conflict: this note id already exists with different content.",
                flags: 64,
                allowed_mentions: { parse: [] },
            }),
        ]);
    });

    it("a writer already-approved outcome never displays Rejected", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script: ContentScript = {
            ...approveScript(),
            reject: () => Effect.succeed("already-approved"),
        };
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData(`note:reject:${NOTE_ID}`)),
            buttonData(`note:reject:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(state.patched).toEqual([
            expect.objectContaining({
                content: noteFinalizedMessage("approved", NOTE_ID).content,
            }),
        ]);
        const rejectedShown = state.patched.some(
            (patch) => patch.content === noteFinalizedMessage("rejected", NOTE_ID).content,
        );
        expect(rejectedShown).toBe(false);
    });

    it("an already-finalized source message is never relabeled", async () => {
        const finalized = {
            ...reviewMessageJson(""),
            content: noteFinalizedMessage("approved", NOTE_ID).content,
            embeds: [],
            components: [],
        };
        const state: TransportState = {
            message: finalized,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(state.patched).toHaveLength(0);
        expect(script.approvals).toHaveLength(0);
        expect(state.followups).toHaveLength(0);
    });

    it("a capacity refusal reports an ephemeral owner followup and keeps controls", async () => {
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = failingContentScript("approve", 422);
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        const job = await runQueuedJob(pendingRef);
        expect(job._tag).toBe("Success");
        expect(state.patched).toHaveLength(0);
        expect(state.followups).toEqual([
            expect.objectContaining({
                content: expect.stringContaining("capacity"),
                flags: 64,
                allowed_mentions: { parse: [] },
            }),
        ]);
    });

    it("opposing clicks are serialized by the moderation permit", async () => {
        const order: Array<string> = [];
        const gate = Deferred.makeUnsafe<void>();
        const moderation = makeModeration();
        const approveJob = moderation.withPermit(
            Effect.gen(function* () {
                yield* Deferred.succeed(gate, undefined);
                order.push("approve");
            }),
        );
        const rejectJob = moderation.withPermit(
            Effect.gen(function* () {
                yield* Deferred.await(gate);
                order.push("reject");
            }),
        );
        await Effect.runPromise(Effect.all([approveJob, rejectJob], { discard: true }));
        expect(order).toEqual(["approve", "reject"]);
    });
});

// ---------------------------------------------------------------------------
// Fail-closed source-message handling
// ---------------------------------------------------------------------------

describe("source message retrieval", () => {
    it("a deleted review message mutates nothing", async () => {
        const state: TransportState = {
            message: null,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        const job = await runQueuedJob(pendingRef);
        expect(job._tag).toBe("Success");
        expect(state.patched).toHaveLength(0);
        expect(script.approvals).toHaveLength(0);
        expect(state.fetched).toBe(1);
    });

    it("a message from another channel or application is left untouched", async () => {
        const forged = {
            ...reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            channel_id: "999999999999999999",
        };
        const state: TransportState = {
            message: forged,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(state.patched).toHaveLength(0);
        expect(script.approvals).toHaveLength(0);
    });

    it("an unparseable footer finalizes malformed and never calls the writer", async () => {
        const corrupted = reviewMessageJson("note.v1:not-valid-base64!!");
        const state: TransportState = {
            message: corrupted,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            approveInteraction(),
            buttonData(`note:approve:${NOTE_ID}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(state.patched).toHaveLength(1);
        expect(state.patched[0]).toEqual(
            expect.objectContaining({
                content: noteFinalizedMessage("malformed", NOTE_ID).content,
            }),
        );
        expect(script.approvals).toHaveLength(0);
    });

    it("a button whose id does not match the message leaves the message alone", async () => {
        const otherId = "b".repeat(32);
        const state: TransportState = {
            message: reviewMessageJson(encodeNotePayload(reviewPayload("pending")) ?? ""),
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        };
        const script = approveScript();
        const { response, pendingRef } = runHandler(
            state,
            makeContentClient(script),
            makeInteraction(buttonData(`note:approve:${otherId}`)),
            buttonData(`note:approve:${otherId}`),
        );
        await response;
        await runQueuedJob(pendingRef);
        expect(state.patched).toHaveLength(0);
        expect(script.approvals).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Startup webhook verification
// ---------------------------------------------------------------------------

describe("verifyNotesWebhook", () => {
    const runVerify = (state: TransportState) =>
        Effect.runPromiseExit(
            verifyNotesWebhook.pipe(
                Effect.provide(
                    Context.make(BotConfig, makeConfig()).pipe((context) =>
                        Context.add(context, NoteModeration, makeModeration()),
                    ),
                ),
                Effect.provide(restLayer(state)),
            ),
        );

    const ownedWebhook = {
        id: WEBHOOK_ID,
        type: 1,
        application_id: CLIENT_ID,
        channel_id: NOTES_CHANNEL_ID,
        guild_id: SERVER_ID,
        name: "Notes Review",
        avatar: null,
    };

    it("accepts an application-owned incoming webhook on the configured channel", async () => {
        const exit = await runVerify({
            message: null,
            webhook: ownedWebhook,
            patched: [],
            followups: [],
            fetched: 0,
        });
        expect(exit._tag).toBe("Success");
    });

    it("fails when the webhook is not application-owned by this bot", async () => {
        const exit = await runVerify({
            message: null,
            webhook: { ...ownedWebhook, type: 1, application_id: null },
            patched: [],
            followups: [],
            fetched: 0,
        });
        expect(exit._tag).toBe("Failure");
    });

    it("fails when the webhook targets a different channel", async () => {
        const exit = await runVerify({
            message: null,
            webhook: { ...ownedWebhook, channel_id: "999999999999999999" },
            patched: [],
            followups: [],
            fetched: 0,
        });
        expect(exit._tag).toBe("Failure");
    });

    it("fails when the webhook cannot be fetched", async () => {
        const exit = await runVerify({
            message: null,
            webhook: null,
            patched: [],
            followups: [],
            fetched: 0,
        });
        expect(exit._tag).toBe("Failure");
    });

    it("fails on an unparseable webhook URL or mismatched configured id", async () => {
        const badUrl: BotConfigService = {
            ...makeConfig(),
            notesWebhookUrl: Redacted.make("https://example.com/not-a-webhook"),
        };
        const badId: BotConfigService = {
            ...makeConfig(),
            notesWebhookId: "666666666666666666",
        };
        for (const config of [badUrl, badId]) {
            const exit = await Effect.runPromiseExit(
                verifyNotesWebhook.pipe(
                    Effect.provide(Context.make(BotConfig, config)),
                    Effect.provide(
                        restLayer({
                            message: null,
                            webhook: ownedWebhook,
                            patched: [],
                            followups: [],
                            fetched: 0,
                        }),
                    ),
                ),
            );
            expect(exit._tag).toBe("Failure");
        }
    });
});

// ---------------------------------------------------------------------------
// Review payload codec
// ---------------------------------------------------------------------------

describe("review payload codec", () => {
    it("round-trips Unicode and markdown-adjacent characters losslessly", () => {
        const payload = {
            v: 1 as const,
            id: NOTE_ID,
            name: "Ünicode ñame 🌟",
            body: "line1\nline2 \\backslash *stars* _under_ `ticks` <angle> |pipe|",
            submittedAt: "2026-09-08T00:00:00.000Z",
            state: "pending" as const,
        };
        const footer = encodeNotePayload(payload);
        expect(footer).not.toBeNull();
        expect(decodeNotePayload(footer ?? "")).toEqual(payload);
    });

    it("rejects junk footers as null", () => {
        expect(decodeNotePayload("")).toBeNull();
        expect(decodeNotePayload("note.v9:AAAA")).toBeNull();
        expect(decodeNotePayload("note.v1:###")).toBeNull();
    });
});
