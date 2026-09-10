/**
 * Boundary tests for the content flows: the custom-id grammar, modal field
 * extraction through Label components, the "the entry moved under you" cases,
 * and the storage-failure boundaries where a wrong decision loses data.
 *
 * The storage fake is an owned, complete content client backed by an
 * in-memory document, so `updateContent` really re-reads and re-applies each
 * change. Discord is the real dfx REST client over an injected HTTP
 * transport, which records the follow-up PATCH bodies the jobs report with,
 * and every interaction fixture is a fully populated Discord payload.
 */
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { DiscordREST, DiscordRESTLive, MemoryRateLimitStoreLive } from "dfx";
import * as DfxDiscordConfig from "dfx/DiscordConfig";
import {
    FocusedOptionContext,
    Interaction,
    MessageComponentData,
    ModalSubmitData,
} from "dfx/Interactions/index";
import * as Discord from "dfx/types";
import { DEFAULT_SITE_CONTENT, SiteContent } from "@artisann-port/presence/content";
import type { DeployedApp, SocialLink, UseItem } from "@artisann-port/presence/content";
import { BotConfig } from "../src/config.ts";
import type { BotConfigService } from "../src/config.ts";
import { BotStorageError, ContentValidationError } from "../src/rpc-client.ts";
import { BotContentClient } from "../src/content-client.ts";
import type { BotContentClientService, NoteApproval } from "../src/content-client.ts";
import {
    PendingInteractionJob,
    deferredComponentAck,
    deferredEphemeralAck,
} from "../src/interaction-jobs.ts";
import {
    cmsCustomId,
    handleAppAutocomplete,
    handleCmsComponent,
    handleCmsModal,
    parseCmsCustomId,
} from "../src/cms.ts";

// ---------------------------------------------------------------------------
// Identities and fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = "100000000000000001";
const SERVER_ID = "200000000000000002";
const OWNER_ID = "300000000000000003";
const INTRUDER_ID = "300000000000000009";
const CHANNEL_ID = "400000000000000004";
const MESSAGE_ID = "500000000000000005";
const INTERACTION_ID = "600000000000000006";
const ASSETS_HOST = "assets.artisann.dev";

type InteractionMember = NonNullable<Discord.APIModalSubmitInteraction["member"]>;
type InteractionUser = InteractionMember["user"];
type InteractionMessage = NonNullable<Discord.APIMessageComponentInteraction["message"]>;
type InteractionChannel = NonNullable<Discord.APIMessageComponentInteraction["channel"]>;
type CommandOption = Discord.APIApplicationCommandInteractionDataOption;
type ModalSubmissionComponent = Discord.APIModalSubmission["components"][number];

/**
 * SAFETY: `locale` is a string enum owned by discord-api-types, which this
 * workspace cannot import (it is dfx's transitive dependency), so the enum
 * object is unavailable here. "en-US" is the value of its `EnglishUS` member.
 * Nothing else in these fixtures is asserted.
 */
const LOCALE = "en-US" as Discord.APIModalSubmitInteraction["locale"];

const user = (id: string): InteractionUser => ({
    id,
    username: `user-${id}`,
    discriminator: "0",
    global_name: null,
    avatar: null,
});

const member = (id: string): InteractionMember => ({
    user: user(id),
    roles: [],
    joined_at: "2026-01-01T00:00:00.000Z",
    deaf: false,
    mute: false,
    // GuildMemberFlags.CompletedOnboarding; the enum has no zero member.
    flags: 2,
    permissions: "0",
});

const channel: InteractionChannel = { id: CHANNEL_ID, type: 0 };

const pickerMessage: InteractionMessage = {
    id: MESSAGE_ID,
    channel_id: CHANNEL_ID,
    author: user(CLIENT_ID),
    content: "Pick the app to edit.",
    timestamp: "2026-09-08T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mention_roles: [],
    mentions: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
};

const autocompleteInteraction = (userId: string, focused: string): Discord.APIInteraction => ({
    id: INTERACTION_ID,
    application_id: CLIENT_ID,
    type: 4,
    data: {
        id: "900000000000000009",
        type: 1,
        name: "apps",
        options: [{ name: "app", type: 3, value: focused, focused: true }],
    },
    guild_id: SERVER_ID,
    channel_id: CHANNEL_ID,
    channel,
    member: member(userId),
    token: "interaction-token",
    version: 1,
    app_permissions: "0",
    locale: LOCALE,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 26_214_400,
});

const focusedAppOption = (value: string): CommandOption => ({
    name: "app",
    type: 3,
    value,
    focused: true,
});

const componentInteraction = (
    userId: string,
    data: Discord.APIMessageComponentInteractionData,
): Discord.APIInteraction => ({
    id: INTERACTION_ID,
    application_id: CLIENT_ID,
    type: 3,
    data,
    guild_id: SERVER_ID,
    channel_id: CHANNEL_ID,
    channel,
    member: member(userId),
    message: pickerMessage,
    token: "interaction-token",
    version: 1,
    app_permissions: "0",
    locale: LOCALE,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 26_214_400,
});

const buttonData = (customId: string): Discord.APIMessageComponentInteractionData => ({
    custom_id: customId,
    component_type: 2,
});

const selectData = (
    customId: string,
    values: ReadonlyArray<string>,
): Discord.APIMessageComponentInteractionData => ({
    custom_id: customId,
    component_type: 3,
    values: [...values],
});

const modalInteraction = (
    userId: string,
    data: Discord.APIModalSubmission,
): Discord.APIInteraction => ({
    id: INTERACTION_ID,
    application_id: CLIENT_ID,
    type: 5,
    data,
    guild_id: SERVER_ID,
    channel_id: CHANNEL_ID,
    channel,
    member: member(userId),
    token: "interaction-token",
    version: 1,
    app_permissions: "0",
    locale: LOCALE,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 26_214_400,
});

/** A modal submission as Discord sends it: every field inside a Label. */
const labeledSubmission = (
    customId: string,
    text: ReadonlyArray<readonly [string, string]>,
    selects: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
): Discord.APIModalSubmission => {
    const textComponents: ModalSubmissionComponent[] = text.map((field) => ({
        type: 18,
        component: { type: 4, custom_id: field[0], value: field[1] },
    }));
    const selectComponents: ModalSubmissionComponent[] = selects.map((field) => ({
        type: 18,
        component: { type: 3, custom_id: field[0], values: [...field[1]] },
    }));
    return {
        custom_id: customId,
        components: [...textComponents, ...selectComponents],
    };
};

const config: BotConfigService = {
    token: Redacted.make("bot-token"),
    clientId: CLIENT_ID,
    serverId: SERVER_ID,
    userId: OWNER_ID,
    notesChannelId: CHANNEL_ID,
    notesWebhookId: "800000000000000008",
    notesWebhookUrl: Redacted.make(
        "https://discord.com/api/webhooks/800000000000000008/webhook-token",
    ),
    portfolioApiUrl: "https://presence.artisann.dev",
    contentWriterToken: Redacted.make("writer-token"),
    assetsHost: ASSETS_HOST,
};

const blockyApp = (): DeployedApp => ({
    id: "blocky",
    name: "Blocky",
    description: "Live Notion data, turned into customizable website widgets.",
    url: "https://www.blocky.so",
    ogImageHosts: [],
});

const herdrApp: DeployedApp = {
    id: "herdr",
    name: "Herdr",
    description: "A terminal multiplexer for coding agents.",
    url: "https://herdr.dev",
    ogImageHosts: [],
};

const contentWithApps = (apps: ReadonlyArray<DeployedApp>): SiteContent => ({
    ...DEFAULT_SITE_CONTENT,
    apps,
});

const MessageIdJson = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const encodeMessageIdJson = Schema.encodeSync(MessageIdJson);

// ---------------------------------------------------------------------------
// Owned storage fake
// ---------------------------------------------------------------------------

/** Everything the fake records, for assertions about what really happened. */
interface StorageState {
    content: SiteContent;
    /** Every document accepted by `updateContent`, in order. */
    readonly writes: Array<SiteContent>;
    /** How many times the authoritative document was read. */
    reads: number;
}

/** Injected failures for the boundaries under test; `null` means "works". */
interface StorageFailures {
    readonly loadContent: BotStorageError | null;
    readonly updateContent: BotStorageError | null;
}

interface StorageFixture {
    readonly storage: BotContentClientService;
    readonly state: StorageState;
}

const noFailures: StorageFailures = {
    loadContent: null,
    updateContent: null,
};

const storageError = (operation: string, status: number | null, reason: string) =>
    new BotStorageError({ operation, status, reason });

/**
 * A complete in-memory content client. `updateContent` behaves like the real
 * writer: it re-reads the current document, applies the caller's change to
 * *that* document, stamps `updatedAt`, and validates the whole result before
 * accepting it.
 */
const makeStorage = (initial: SiteContent, failures: StorageFailures): StorageFixture => {
    const state: StorageState = {
        content: initial,
        writes: [],
        reads: 0,
    };
    const validate = Schema.decodeUnknownEffect(SiteContent);

    const loadContent = Effect.suspend(() => {
        state.reads += 1;
        return failures.loadContent === null
            ? Effect.succeed(state.content)
            : Effect.fail(failures.loadContent);
    });

    const storage: BotContentClientService = {
        loadContent,
        updateContent: (change) =>
            Effect.gen(function* () {
                if (failures.updateContent !== null) return yield* failures.updateContent;
                const current = yield* loadContent;
                const next = change(current);
                if (Result.isFailure(next)) return yield* next.failure;
                const now = yield* DateTime.now;
                const stamped: SiteContent = {
                    ...next.success,
                    updatedAt: DateTime.formatIso(now),
                };
                const decoded = yield* validate(stamped).pipe(
                    Effect.mapError(
                        () =>
                            new ContentValidationError({
                                message: "The edited document failed validation",
                            }),
                    ),
                );
                state.content = decoded;
                state.writes.push(decoded);
                return decoded;
            }),
        approveNote: (
            approval: NoteApproval,
        ): Effect.Effect<
            "approved" | "already-approved",
            BotStorageError | ContentValidationError
        > =>
            Effect.gen(function* () {
                if (state.content.notes.some((note) => note.id === approval.id)) {
                    return "already-approved";
                }
                const now = yield* DateTime.now;
                state.content = {
                    ...state.content,
                    notes: [
                        ...state.content.notes,
                        {
                            id: approval.id,
                            name: approval.name,
                            body: approval.body,
                            submittedAt: approval.submittedAt,
                            approvedAt: DateTime.formatIso(now),
                        },
                    ],
                };
                return "approved";
            }),
        rejectNote: (
            id: string,
        ): Effect.Effect<"rejected" | "already-rejected" | "already-approved", BotStorageError> =>
            Effect.sync(() =>
                state.content.notes.some((note) => note.id === id)
                    ? "already-approved"
                    : "rejected",
            ),
        deleteNote: () => Effect.die("unexpected deleteNote in CMS test"),
    };
    return { storage, state };
};

// ---------------------------------------------------------------------------
// Discord transport: the real dfx REST client over a recording HTTP client
// ---------------------------------------------------------------------------

/** One outgoing HTTP request, as the injected transport saw it. */
interface RecordedRequest {
    readonly method: string;
    readonly url: string;
    readonly body: string;
}

const PatchedMessage = Schema.Struct({ content: Schema.String });
const decodePatched = Schema.decodeUnknownSync(Schema.fromJsonString(PatchedMessage));

const recordingTransport = (requests: Array<RecordedRequest>): HttpClient.HttpClient =>
    HttpClient.make((request, url) =>
        Effect.sync(() => {
            requests.push({
                method: request.method,
                url: url.href,
                body:
                    request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "",
            });
            return HttpClientResponse.fromWeb(
                request,
                new Response(encodeMessageIdJson({ id: MESSAGE_ID }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }),
    );

interface Harness {
    readonly state: StorageState;
    readonly requests: Array<RecordedRequest>;
    readonly services: Layer.Layer<
        BotConfig | BotContentClient | DiscordREST | HttpClient.HttpClient
    >;
}

const harness = (initial: SiteContent, failures: StorageFailures): Harness => {
    const { storage, state } = makeStorage(initial, failures);
    const requests: Array<RecordedRequest> = [];
    const httpClient = Layer.succeed(HttpClient.HttpClient, recordingTransport(requests));
    const rest = DiscordRESTLive.pipe(
        Layer.provide(
            Layer.mergeAll(
                MemoryRateLimitStoreLive,
                DfxDiscordConfig.layer({ token: Redacted.make("bot-token") }),
                httpClient,
            ),
        ),
    );
    const services = Layer.mergeAll(
        Layer.succeed(BotConfig, config),
        Layer.succeed(BotContentClient, storage),
        httpClient,
        rest,
    );
    return { state, requests, services };
};

const emptyJobSlot = () => Ref.makeUnsafe(Option.none<Effect.Effect<void>>());

/** Run one queued job to completion; fails the test when nothing was queued. */
const runQueuedJob = async (slot: Ref.Ref<Option.Option<Effect.Effect<void>>>) => {
    const job = Effect.runSync(Ref.get(slot));
    expect(Option.isSome(job)).toBe(true);
    if (Option.isNone(job)) return;
    await Effect.runPromise(job.value);
};

const patchedContents = (requests: ReadonlyArray<RecordedRequest>): ReadonlyArray<string> =>
    requests
        .filter((request) => request.method === "PATCH")
        .map((request) => decodePatched(request.body).content);

// ---------------------------------------------------------------------------
// Handler runners
// ---------------------------------------------------------------------------

interface HandlerRun {
    readonly response: Discord.CreateInteractionResponseRequest;
    readonly slot: Ref.Ref<Option.Option<Effect.Effect<void>>>;
}

const runComponent = async (
    world: Harness,
    userId: string,
    data: Discord.APIMessageComponentInteractionData,
): Promise<HandlerRun> => {
    const slot = emptyJobSlot();
    const response = await Effect.runPromise(
        handleCmsComponent.pipe(
            Effect.provideService(Interaction, componentInteraction(userId, data)),
            Effect.provideService(MessageComponentData, data),
            Effect.provideService(PendingInteractionJob, { ref: slot }),
            Effect.provide(world.services),
        ),
    );
    return { response, slot };
};

const runModal = async (
    world: Harness,
    userId: string,
    data: Discord.APIModalSubmission,
): Promise<HandlerRun> => {
    const slot = emptyJobSlot();
    const response = await Effect.runPromise(
        handleCmsModal.pipe(
            Effect.provideService(Interaction, modalInteraction(userId, data)),
            Effect.provideService(ModalSubmitData, data),
            Effect.provideService(PendingInteractionJob, { ref: slot }),
            Effect.provide(world.services),
        ),
    );
    return { response, slot };
};

const runAutocomplete = async (world: Harness, userId: string, focused: string) =>
    await Effect.runPromise(
        handleAppAutocomplete.pipe(
            Effect.provideService(Interaction, autocompleteInteraction(userId, focused)),
            Effect.provideService(FocusedOptionContext, focusedAppOption(focused)),
            Effect.provide(world.services),
        ),
    );

// ---------------------------------------------------------------------------
// Custom-id grammar
// ---------------------------------------------------------------------------

describe("cms custom ids", () => {
    it("accepts the section and entry forms it builds", () => {
        expect(parseCmsCustomId(cmsCustomId("apps", "pick-edit", null))).toEqual({
            section: "apps",
            action: "pick-edit",
            id: null,
        });
        expect(parseCmsCustomId(cmsCustomId("socials", "confirm", "github"))).toEqual({
            section: "socials",
            action: "confirm",
            id: "github",
        });
    });

    it("rejects ids that could build an invalid entry id, key or Discord payload", () => {
        expect(parseCmsCustomId(`cms:apps:confirm:${"a".repeat(33)}`)).toBeNull();
        expect(parseCmsCustomId("cms:apps:confirm:Blocky")).toBeNull();
        expect(parseCmsCustomId("cms:apps:confirm:blo cky")).toBeNull();
        expect(parseCmsCustomId("cms:apps:destroy:blocky")).toBeNull();
        expect(parseCmsCustomId("cms:games:confirm:blocky")).toBeNull();
        expect(parseCmsCustomId("cms:apps:confirm:blocky:extra")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("cms authorization", () => {
    it("denies a non-owner component click without reading or writing", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        const run = await runComponent(world, INTRUDER_ID, buttonData("cms:apps:confirm:blocky"));
        expect(run.response).toHaveProperty("type", 4);
        expect(Option.isNone(Effect.runSync(Ref.get(run.slot)))).toBe(true);
        expect(world.state.reads).toBe(0);
        expect(world.state.writes).toHaveLength(0);
    });

    it("answers a non-owner autocomplete with empty choices and no read", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        const response = await runAutocomplete(world, INTRUDER_ID, "blo");
        expect(response).toEqual({ type: 8, data: { choices: [] } });
        expect(world.state.reads).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Records and uses modals
// ---------------------------------------------------------------------------

describe("records modal submissions", () => {
    it("answers invalid records immediately, naming the field, with no write", async () => {
        const invalidCases: ReadonlyArray<{
            readonly fields: ReadonlyArray<readonly [string, string]>;
            readonly label: string;
        }> = [
            {
                fields: [
                    ["bench", "abc"],
                    ["squat", "485"],
                    ["deadlift", "525"],
                ],
                label: "Bench",
            },
            {
                fields: [
                    ["bench", "325"],
                    ["squat", "0"],
                    ["deadlift", "525"],
                ],
                label: "Squat",
            },
            {
                fields: [
                    ["bench", "325"],
                    ["squat", "485"],
                    ["deadlift", "10001"],
                ],
                label: "Deadlift",
            },
        ];
        for (const invalid of invalidCases) {
            const world = harness(DEFAULT_SITE_CONTENT, noFailures);
            const run = await runModal(
                world,
                OWNER_ID,
                labeledSubmission("cms:records:edit", invalid.fields, []),
            );
            expect(run.response).toHaveProperty("type", 4);
            expect(JSON.stringify(run.response)).toContain(invalid.label);
            expect(Option.isNone(Effect.runSync(Ref.get(run.slot)))).toBe(true);
            expect(world.state.writes).toHaveLength(0);
        }
    });

    it("saves all three records from Label-wrapped inputs and reports them", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:records:edit",
                [
                    ["bench", " 330 "],
                    ["squat", "490"],
                    ["deadlift", "530.5"],
                ],
                [],
            ),
        );
        expect(run.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(run.slot);
        expect(world.state.content.records).toEqual({
            bench: 330,
            squat: 490,
            deadlift: 530.5,
        });
        expect(world.state.content.apps).toEqual(DEFAULT_SITE_CONTENT.apps);
        expect(patchedContents(world.requests)).toEqual([
            "Saved records — bench 330, squat 490, deadlift 530.5.",
        ]);
    });
});

describe("uses modal submissions", () => {
    it("refuses an over-cap group by name and writes nothing", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const tooMany = Array.from({ length: 26 }, (_, index) => `Item ${index}`).join("\n");
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:uses:edit",
                [
                    ["software", "Herdr"],
                    ["hardware", tooMany],
                    ["languages", "Go"],
                ],
                [],
            ),
        );
        expect(run.response).toHaveProperty("type", 4);
        expect(JSON.stringify(run.response)).toContain("Hardware");
        expect(world.state.writes).toHaveLength(0);
    });

    it("parses labels and em-dash notes into the three lists", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:uses:edit",
                [
                    ["software", "Herdr\nGhostty"],
                    ["hardware", "MacBook Pro M4"],
                    ["languages", "JS / TS — Effect highly pilled\nGo"],
                ],
                [],
            ),
        );
        expect(run.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(run.slot);
        const expected: ReadonlyArray<UseItem> = [
            { label: "JS / TS", note: "Effect highly pilled" },
            { label: "Go", note: null },
        ];
        expect(world.state.content.uses.languages).toEqual(expected);
        expect(world.state.content.uses.software).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Entry modals and pickers
// ---------------------------------------------------------------------------

describe("entry modal submissions", () => {
    it("extracts a select field and trims text when adding a social link", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:socials:add",
                [
                    ["label", "  Bluesky  "],
                    ["url", " https://bsky.app/profile/artisann "],
                ],
                [["icon", ["bluesky"]]],
            ),
        );
        expect(run.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(run.slot);
        const added = world.state.content.socials.find((social) => social.id === INTERACTION_ID);
        const expected: SocialLink = {
            id: INTERACTION_ID,
            label: "Bluesky",
            url: "https://bsky.app/profile/artisann",
            icon: "bluesky",
        };
        expect(added).toEqual(expected);
        expect(patchedContents(world.requests)).toEqual(["Added the social link **Bluesky**."]);
    });

    it("refuses a non-https app url before touching storage", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:apps:add",
                [
                    ["name", "Blocky"],
                    ["description", "Widgets."],
                    ["url", "http://www.blocky.so"],
                ],
                [],
            ),
        );
        expect(run.response).toHaveProperty("type", 4);
        expect(JSON.stringify(run.response)).toContain("URL");
        expect(world.state.reads).toBe(0);
        expect(world.state.writes).toHaveLength(0);
    });

    it("edits the app the custom id names", async () => {
        const world = harness(contentWithApps([blockyApp(), herdrApp]), noFailures);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:apps:edit:blocky",
                [
                    ["name", "Blocky Cloud"],
                    ["description", "Notion widgets, hosted."],
                    ["url", "https://www.blocky.so"],
                ],
                [],
            ),
        );
        expect(run.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(run.slot);
        const edited = world.state.content.apps.find((app) => app.id === "blocky");
        expect(edited?.name).toBe("Blocky Cloud");
        expect(edited?.ogImageHosts).toEqual([]);
        expect(world.state.content.apps.find((app) => app.id === "herdr")).toEqual(herdrApp);
    });

    it("reports an edit whose entry was removed meanwhile, writing nothing", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        world.state.content = contentWithApps([herdrApp]);
        const run = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:apps:edit:blocky",
                [
                    ["name", "Blocky Cloud"],
                    ["description", "Notion widgets, hosted."],
                    ["url", "https://www.blocky.so"],
                ],
                [],
            ),
        );
        expect(run.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(run.slot);
        expect(world.state.writes).toHaveLength(0);
        expect(patchedContents(world.requests)).toEqual(["That entry no longer exists."]);
    });
});

describe("experience and fact entry flows", () => {
    it("appends experience in authored order and edits it by stable id", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const added = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:experience:add",
                [
                    ["company", "  Acme  "],
                    ["years", "2020 — 2024"],
                    ["title", "Engineer"],
                ],
                [],
            ),
        );
        expect(added.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(added.slot);
        expect(world.state.content.experience.at(-1)).toEqual({
            id: INTERACTION_ID,
            company: "Acme",
            years: "2020 — 2024",
            title: "Engineer",
        });
        const edited = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                `cms:experience:edit:${INTERACTION_ID}`,
                [
                    ["company", "Acme"],
                    ["years", "2021 — Present"],
                    ["title", "Staff Engineer"],
                ],
                [],
            ),
        );
        expect(edited.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(edited.slot);
        expect(world.state.content.experience.at(-1)?.title).toBe("Staff Engineer");
    });

    it("adds and removes a fact without allowing a non-owner to write", async () => {
        const world = harness(DEFAULT_SITE_CONTENT, noFailures);
        const denied = await runModal(
            world,
            INTRUDER_ID,
            labeledSubmission("cms:facts:add", [["label", "Secret"]], [["icon", ["cats"]]]),
        );
        expect(denied.response).toHaveProperty("type", 4);
        expect(world.state.writes).toHaveLength(0);
        const added = await runModal(
            world,
            OWNER_ID,
            labeledSubmission("cms:facts:add", [["label", "Two cats"]], [["icon", ["cats"]]]),
        );
        expect(added.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(added.slot);
        expect(world.state.content.facts.at(-1)).toEqual({
            id: INTERACTION_ID,
            icon: "cats",
            label: "Two cats",
        });
        const removed = await runComponent(
            world,
            OWNER_ID,
            buttonData(`cms:facts:confirm:${INTERACTION_ID}`),
        );
        expect(removed.response).toEqual(deferredComponentAck);
        await runQueuedJob(removed.slot);
        expect(world.state.content.facts.some((fact) => fact.id === INTERACTION_ID)).toBe(false);
    });

    it("parses and deduplicates approved OG hosts before writing", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        const edited = await runModal(
            world,
            OWNER_ID,
            labeledSubmission(
                "cms:apps:edit:blocky",
                [
                    ["name", "Blocky"],
                    ["description", "Widgets."],
                    ["url", "https://www.blocky.so"],
                    ["ogImageHosts", "CDN.Example.com\ncdn.example.com"],
                ],
                [],
            ),
        );
        expect(edited.response).toEqual(deferredEphemeralAck);
        await runQueuedJob(edited.slot);
        expect(world.state.content.apps[0]?.ogImageHosts).toEqual(["cdn.example.com"]);
    });
});

describe("entry pickers", () => {
    it("re-renders the picker from the current document when the pick is gone", async () => {
        const world = harness(contentWithApps([blockyApp(), herdrApp]), noFailures);
        world.state.content = contentWithApps([herdrApp]);
        const run = await runComponent(
            world,
            OWNER_ID,
            selectData("cms:apps:pick-edit", ["blocky"]),
        );
        expect(run.response).toHaveProperty("type", 7);
        const rendered = JSON.stringify(run.response);
        expect(rendered).toContain("That entry no longer exists.");
        expect(rendered).toContain("herdr");
        expect(rendered).not.toContain("blocky");
        expect(world.state.writes).toHaveLength(0);
    });

    it("opens the prefilled modal for a live pick", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        const run = await runComponent(
            world,
            OWNER_ID,
            selectData("cms:apps:pick-edit", ["blocky"]),
        );
        expect(run.response).toHaveProperty("type", 9);
        expect(JSON.stringify(run.response)).toContain("cms:apps:edit:blocky");
        expect(world.state.writes).toHaveLength(0);
    });

    it("cancels without mutating anything", async () => {
        const world = harness(contentWithApps([blockyApp()]), noFailures);
        const run = await runComponent(world, OWNER_ID, buttonData("cms:apps:cancel"));
        expect(run.response).toHaveProperty("type", 7);
        expect(JSON.stringify(run.response)).toContain("Cancelled");
        expect(world.state.reads).toBe(0);
        expect(world.state.writes).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

describe("entry removal", () => {
    it("removes the app named by the confirmation id", async () => {
        const world = harness(contentWithApps([blockyApp(), herdrApp]), noFailures);
        const run = await runComponent(world, OWNER_ID, buttonData("cms:apps:confirm:blocky"));
        expect(run.response).toEqual(deferredComponentAck);
        await runQueuedJob(run.slot);
        expect(world.state.content.apps).toEqual([herdrApp]);
        expect(patchedContents(world.requests)).toEqual(["Removed **Blocky**."]);
    });

    it("reports a confirm for an id that is already gone without writing", async () => {
        const world = harness(contentWithApps([herdrApp]), noFailures);
        const run = await runComponent(world, OWNER_ID, buttonData("cms:apps:confirm:blocky"));
        await runQueuedJob(run.slot);
        expect(world.state.writes).toHaveLength(0);
        expect(patchedContents(world.requests)).toEqual(["That entry no longer exists."]);
    });
});

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

describe("app autocomplete", () => {
    it("matches name or id case-insensitively and answers with app ids", async () => {
        const world = harness(contentWithApps([blockyApp(), herdrApp]), noFailures);
        const response = await runAutocomplete(world, OWNER_ID, "BLOCK");
        expect(response).toEqual({
            type: 8,
            data: { choices: [{ name: "Blocky", value: "blocky" }] },
        });
    });

    it("caps the choice list at Discord's limit", async () => {
        const many = Array.from({ length: 25 }, (_, index) => ({
            ...herdrApp,
            id: `app-${index}`,
            name: `App ${index}`,
        }));
        const world = harness(contentWithApps(many), noFailures);
        const response = await runAutocomplete(world, OWNER_ID, "app");
        const decoded = Schema.decodeUnknownSync(
            Schema.Struct({
                data: Schema.Struct({
                    choices: Schema.Array(Schema.Struct({ value: Schema.String })),
                }),
            }),
        )(response);
        expect(decoded.data.choices).toHaveLength(25);
    });

    it("answers with empty choices when the document cannot be read", async () => {
        const world = harness(contentWithApps([blockyApp()]), {
            ...noFailures,
            loadContent: storageError("loadContent", 503, "Unavailable"),
        });
        const response = await runAutocomplete(world, OWNER_ID, "blo");
        expect(response).toEqual({ type: 8, data: { choices: [] } });
    });
});
