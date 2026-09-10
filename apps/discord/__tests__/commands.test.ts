import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Discord from "dfx/types";
import { DiscordConfig, DiscordRESTLive, MemoryRateLimitStoreLive } from "dfx";
import { Ix } from "dfx";
import sharp from "sharp";
import { commandInvocation, stringOption, syncConfiguredGuild } from "../src/commands.ts";
import { verifyStartupIdentity } from "../src/main.ts";
import { makePostHandler, PendingInteractionJob, queueJob } from "../src/interaction-jobs.ts";
import { BotConfig } from "../src/config.ts";
import type { BotConfigService } from "../src/config.ts";
import { BotPhotoClient } from "../src/photo-client.ts";
import type { BotPhotoClientService } from "../src/photo-client.ts";
import { handlePhotosComponent } from "../src/photos.ts";
import {
    MAX_ATTACHMENT_BYTES,
    normalizeImage,
    parseAttachmentUrl,
    parsePhotosCustomId,
    photoIdFromKey,
    renderGallery,
} from "../src/photos.ts";
import type { Photo } from "@artisann-port/presence/photos";

class AckRefused extends Schema.TaggedError<AckRefused>()("Test.AckRefused", {}) {}

const interactionData = {
    id: "100000000000000008",
    name: "apps",
    type: Discord.ApplicationCommandType.CHAT,
    options: [
        {
            type: Discord.ApplicationCommandOptionType.SUB_COMMAND,
            name: "add",
            options: [
                {
                    type: Discord.ApplicationCommandOptionType.STRING,
                    name: "app",
                    value: "blocky",
                },
            ],
        },
    ],
} satisfies Discord.APIChatInputApplicationCommandInteractionData;

const photo = (id: string, uploadedAt: string): Photo => ({
    key: `life/${id}.webp`,
    url: `https://assets.example.com/life/${id}.webp`,
    uploadedAt,
});

describe("command extraction", () => {
    it("keeps the subcommand path separate from its leaf options", () => {
        const invocation = commandInvocation(interactionData);
        expect(invocation.path).toEqual(["add"]);
        expect(stringOption(invocation, "app")).toBe("blocky");
        expect(stringOption(invocation, "image")).toBeNull();
        expect(stringOption(invocation, "missing")).toBeNull();
    });

    it("accepts only the two Discord attachment hosts and their attachment path", () => {
        expect(
            parseAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/a.png"),
        ).not.toBeNull();
        expect(parseAttachmentUrl("https://media.discord.net/attachments/1/2/a.png")).toBeNull();
        expect(parseAttachmentUrl("https://cdn.discordapp.com/other/1/2/a.png")).toBeNull();
        expect(
            parseAttachmentUrl("https://cdn.discordapp.com:443/attachments/1/2/a.png"),
        ).toBeNull();
        expect(
            parseAttachmentUrl("https://user:pass@cdn.discordapp.com/attachments/1/2/a.png"),
        ).toBeNull();
    });
});

describe("deferred response ownership", () => {
    it("does not start a queued job when the response effect fails", async () => {
        let ran = 0;
        const failed = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const scope = yield* Effect.scope;
                    const post = makePostHandler(scope);
                    return yield* post(
                        Effect.gen(function* () {
                            yield* queueJob(
                                Effect.sync(() => {
                                    ran += 1;
                                }),
                            );
                            return yield* new AckRefused();
                        }),
                    );
                }),
            ),
        );
        expect(failed).toBeUndefined();
        expect(ran).toBe(0);
    });

    it("forks a queued job only after the successful response effect", async () => {
        const finished = Deferred.makeUnsafe<void>();
        const ran = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const scope = yield* Effect.scope;
                    const post = makePostHandler(scope);
                    yield* post(
                        Effect.gen(function* () {
                            yield* queueJob(Deferred.succeed(finished, undefined));
                            return;
                        }),
                    );
                    yield* Deferred.await(finished);
                    return true;
                }),
            ),
        );
        expect(ran).toBe(true);
    });
});

describe("real sharp normalization boundaries", () => {
    it("normalizes PNG and AVIF to metadata-free WebP", async () => {
        const png = await sharp({
            create: { width: 8, height: 4, channels: 3, background: "#56789a" },
        })
            .png()
            .toBuffer();
        const avif = await sharp(png).avif({ quality: 55 }).toBuffer();
        for (const input of [png, avif]) {
            const result = await Effect.runPromise(normalizeImage(input));
            const metadata = await sharp(result.bytes).metadata();
            expect(metadata.format).toBe("webp");
            expect(metadata.width).toBe(8);
            expect(metadata.height).toBe(4);
            expect(metadata.exif).toBeUndefined();
        }
    });

    it("rejects GIF, SVG and animated WebP instead of trusting file claims", async () => {
        const source = sharp({
            create: { width: 8, height: 8, channels: 3, background: "#789abc" },
        });
        const gif = await source.gif().toBuffer();
        const frameA = await sharp({
            create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
        })
            .png()
            .toBuffer();
        const frameB = await sharp({
            create: { width: 8, height: 8, channels: 3, background: "#00ff00" },
        })
            .png()
            .toBuffer();
        const animated = await sharp([frameA, frameB], { join: { animated: true } })
            .webp()
            .toBuffer();
        const svg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
        );
        for (const input of [gif, animated, svg]) {
            const result = await Effect.runPromiseExit(normalizeImage(input));
            expect(Exit.isFailure(result)).toBe(true);
        }
    });

    it("limits decoded dimensions and preserves the 20 MiB input boundary", async () => {
        const large = await sharp({
            create: { width: 4000, height: 2000, channels: 3, background: "#204060" },
        })
            .png()
            .toBuffer();
        const result = await Effect.runPromise(normalizeImage(large));
        const metadata = await sharp(result.bytes).metadata();
        expect(metadata.width).toBe(1920);
        expect(metadata.height).toBe(960);
        expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    });
});

describe("stateless gallery identity", () => {
    it("keeps exact ids stable across reorder and never uses an array offset", () => {
        const older = photo("100000000000000010", "2026-09-08T00:00:00.000Z");
        const selected = photo("100000000000000011", "2026-09-08T00:01:00.000Z");
        expect(photoIdFromKey("life", selected.key)).toBe("100000000000000011");
        expect(parsePhotosCustomId("photos:life:confirm:100000000000000011")).toEqual({
            tag: "life",
            action: "confirm",
            photoId: "100000000000000011",
        });
        const reordered = [
            photo("100000000000000012", "2026-09-08T00:02:00.000Z"),
            selected,
            older,
        ];
        const payload = renderGallery("life", reordered, "100000000000000011", null);
        expect(payload.embeds[0]?.footer?.text).toContain("id 100000000000000011");
        expect(parsePhotosCustomId("photos:life:confirm:100000000000000099")).toEqual({
            tag: "life",
            action: "confirm",
            photoId: "100000000000000099",
        });
    });
});

const PHOTO_CLIENT_ID = "111111111111111111";
const PHOTO_SERVER_ID = "222222222222222222";
const PHOTO_OWNER_ID = "333333333333333333";
const PHOTO_CHANNEL_ID = "444444444444444444";
const PHOTO_INTERACTION_ID = "999999999999999999";

interface PhotoTransportState {
    patches: number;
}

const photoResponseMessage = {
    id: PHOTO_INTERACTION_ID,
    channel_id: PHOTO_CHANNEL_ID,
    author: {
        id: PHOTO_CLIENT_ID,
        username: "Photos",
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
    embeds: [],
    pinned: false,
    type: 0,
    flags: 0,
    webhook_id: null,
    application_id: PHOTO_CLIENT_ID,
    components: [],
};

const makePhotoTransportLayer = (state: PhotoTransportState) =>
    Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
            const body =
                request.body instanceof HttpBody.Uint8Array
                    ? new TextDecoder().decode(request.body.body)
                    : null;
            if (request.method === "PATCH" && request.url.endsWith("/messages/@original")) {
                if (body === null) return Effect.die("missing PATCH body");
                state.patches += 1;
                return Effect.succeed(
                    HttpClientResponse.fromWeb(
                        request,
                        Response.json(photoResponseMessage, { status: 200 }),
                    ),
                );
            }
            return Effect.die(`unexpected photo REST request ${request.method} ${request.url}`);
        }),
    );

const photoRestLayer = (state: PhotoTransportState) =>
    DiscordRESTLive.pipe(
        Layer.provide(DiscordConfig.layer({ token: Redacted.make("config-token-for-tests") })),
        Layer.provide(MemoryRateLimitStoreLive),
        Layer.provide(makePhotoTransportLayer(state)),
    );

interface PhotoStorageState {
    photos: ReadonlyArray<Photo>;
    readonly deleted: string[];
    reads: number;
}

const makePhotoStorage = (state: PhotoStorageState): BotPhotoClientService => ({
    listPhotos: () =>
        Effect.sync(() => {
            state.reads += 1;
            return state.photos;
        }),
    putPhoto: () => Effect.die("unexpected putPhoto in photo test"),
    deletePhoto: (_tag, photoId) => {
        state.deleted.push(photoId);
        state.photos = state.photos.filter((photo) => !photo.key.includes(`/${photoId}.`));
        return Effect.void;
    },
});

const photoConfig = (): BotConfigService => ({
    token: Redacted.make("bot-token"),
    clientId: PHOTO_CLIENT_ID,
    serverId: PHOTO_SERVER_ID,
    userId: PHOTO_OWNER_ID,
    notesChannelId: PHOTO_CHANNEL_ID,
    notesWebhookId: "555555555555555555",
    notesWebhookUrl: Redacted.make("https://discord.com/api/webhooks/555555555555555555/test"),
    portfolioApiUrl: "https://presence.artisann.dev",
    contentWriterToken: Redacted.make("writer-token"),
    assetsHost: "assets.example.com",
});

/**
 * SAFETY: locale is a fixed Discord wire literal; this test never branches on
 * locale, and the direct dfx type does not re-export discord-api-types Locale.
 */
const PHOTO_LOCALE = "en-US" as Discord.APIMessageComponentInteraction["locale"];

const photoInteractionMessage = (): NonNullable<
    Discord.APIMessageComponentInteraction["message"]
> => ({
    id: PHOTO_INTERACTION_ID,
    channel_id: PHOTO_CHANNEL_ID,
    author: {
        id: PHOTO_OWNER_ID,
        username: "owner",
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
    embeds: [],
    pinned: false,
    type: 0,
    components: [],
});

const photoInteraction = (
    data: Discord.APIMessageComponentInteractionData,
    overrides?: { readonly guildId?: string; readonly userId?: string },
): Discord.APIMessageComponentInteraction => ({
    id: PHOTO_INTERACTION_ID,
    application_id: PHOTO_CLIENT_ID,
    type: 3,
    token: "interaction-token",
    version: 1,
    guild_id:
        overrides !== undefined && "guildId" in overrides ? overrides.guildId : PHOTO_SERVER_ID,
    channel_id: PHOTO_CHANNEL_ID,
    channel: { id: PHOTO_CHANNEL_ID, type: 0 },
    user: {
        id: overrides?.userId ?? PHOTO_OWNER_ID,
        username: "owner",
        discriminator: "0",
        avatar: null,
        global_name: null,
    },
    data,
    message: photoInteractionMessage(),
    app_permissions: "0",
    locale: PHOTO_LOCALE,
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10485760,
});

const photoButton = (customId: string): Discord.APIMessageComponentInteractionData => ({
    custom_id: customId,
    component_type: 2,
});

const runPhotoHandler = async (
    state: PhotoTransportState,
    storage: BotPhotoClientService,
    interaction: Discord.APIInteraction,
    data: Discord.APIMessageComponentInteractionData,
) => {
    const pendingRef = Ref.makeUnsafe(Option.none<Effect.Effect<void>>());
    const context = Context.make(BotConfig, photoConfig()).pipe(
        (value) => Context.add(value, BotPhotoClient, storage),
        (value) => Context.add(value, PendingInteractionJob, { ref: pendingRef }),
        (value) => Context.add(value, Ix.Interaction, interaction),
        (value) => Context.add(value, Ix.MessageComponentData, data),
    );
    const response = await Effect.runPromiseExit(
        handlePhotosComponent.pipe(Effect.provide(context), Effect.provide(photoRestLayer(state))),
    );
    return { response, pendingRef };
};

const runPhotoJob = async (pendingRef: Ref.Ref<Option.Option<Effect.Effect<void>>>) => {
    const queued = Effect.runSync(Ref.get(pendingRef));
    expect(Option.isSome(queued)).toBe(true);
    if (Option.isNone(queued)) throw new Error("photo action did not queue a job");
    return Effect.runPromiseExit(queued.value);
};

describe("photo gallery handlers", () => {
    it("deny other guilds, users, and DMs before any storage or REST IO", async () => {
        const denied = [
            photoInteraction(photoButton("photos:life:delete:100000000000000010"), {
                guildId: "999999999999999999",
            }),
            photoInteraction(photoButton("photos:life:delete:100000000000000010"), {
                userId: "888888888888888888",
            }),
            photoInteraction(photoButton("photos:life:delete:100000000000000010"), {
                guildId: undefined,
            }),
        ];
        for (const interaction of denied) {
            const transport = { patches: 0 };
            const storageState = {
                photos: [photo("100000000000000010", "2026-09-08T00:00:00.000Z")],
                deleted: [],
                reads: 0,
            };
            const storage = makePhotoStorage(storageState);
            const result = await runPhotoHandler(transport, storage, interaction, interaction.data);
            expect(Exit.isSuccess(result.response)).toBe(true);
            expect(transport.patches).toBe(0);
            expect(storageState.reads).toBe(0);
        }
    });

    it("revalidates between prompt and confirm and deletes the exact id after reorder", async () => {
        const selected = photo("100000000000000010", "2026-09-08T00:00:00.000Z");
        const replacement = photo("100000000000000011", "2026-09-08T00:01:00.000Z");
        const state: PhotoStorageState = { photos: [selected, replacement], deleted: [], reads: 0 };
        const transport = { patches: 0 };
        const prompt = await runPhotoHandler(
            transport,
            makePhotoStorage(state),
            photoInteraction(photoButton("photos:life:delete:100000000000000010")),
            photoButton("photos:life:delete:100000000000000010"),
        );
        await runPhotoJob(prompt.pendingRef);
        state.photos = [replacement, selected];
        const confirm = await runPhotoHandler(
            transport,
            makePhotoStorage(state),
            photoInteraction(photoButton("photos:life:confirm:100000000000000010")),
            photoButton("photos:life:confirm:100000000000000010"),
        );
        await runPhotoJob(confirm.pendingRef);
        expect(state.deleted).toEqual(["100000000000000010"]);
        expect(state.photos).toEqual([replacement]);
    });

    it("never deletes a replacement on a repeated stale confirm", async () => {
        const oldPhoto = photo("100000000000000010", "2026-09-08T00:00:00.000Z");
        const replacement = photo("100000000000000011", "2026-09-08T00:01:00.000Z");
        const state: PhotoStorageState = { photos: [oldPhoto, replacement], deleted: [], reads: 0 };
        const transport = { patches: 0 };
        const first = await runPhotoHandler(
            transport,
            makePhotoStorage(state),
            photoInteraction(photoButton("photos:life:confirm:100000000000000010")),
            photoButton("photos:life:confirm:100000000000000010"),
        );
        await runPhotoJob(first.pendingRef);
        state.photos = [replacement];
        const repeated = await runPhotoHandler(
            transport,
            makePhotoStorage(state),
            photoInteraction(photoButton("photos:life:confirm:100000000000000010")),
            photoButton("photos:life:confirm:100000000000000010"),
        );
        await runPhotoJob(repeated.pendingRef);
        expect(state.deleted).toEqual(["100000000000000010"]);
        expect(state.photos).toEqual([replacement]);
    });

    it("cancel never deletes, including with an empty gallery", async () => {
        const state: PhotoStorageState = { photos: [], deleted: [], reads: 0 };
        const transport = { patches: 0 };
        const result = await runPhotoHandler(
            transport,
            makePhotoStorage(state),
            photoInteraction(photoButton("photos:life:cancel:100000000000000010")),
            photoButton("photos:life:cancel:100000000000000010"),
        );
        await runPhotoJob(result.pendingRef);
        expect(state.deleted).toEqual([]);
        expect(state.photos).toEqual([]);
    });
});

function startupLayer(reply: (method: string, path: string) => Response) {
    const client = HttpClient.make((request, url) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, reply(request.method, url.pathname))),
    );
    const dependencies = Layer.mergeAll(
        DiscordConfig.layer({ token: Redacted.make("startup-fixture") }),
        MemoryRateLimitStoreLive,
        Layer.succeed(HttpClient.HttpClient, client),
    );
    const rest = DiscordRESTLive.pipe(Layer.provide(dependencies));
    return Layer.mergeAll(rest, Layer.succeed(BotConfig, photoConfig()));
}

describe("installation-safe startup", () => {
    it("allows startup to reach the Gateway while guild channels are inaccessible", async () => {
        const paths: string[] = [];
        const layer = startupLayer((_method, path) => {
            paths.push(path);
            if (path.endsWith("/applications/@me")) return Response.json({ id: PHOTO_CLIENT_ID });
            return Response.json({ message: "Missing access", code: 50001 }, { status: 403 });
        });
        const result = await Effect.runPromise(
            Effect.result(verifyStartupIdentity).pipe(Effect.provide(layer)),
        );
        expect(result).toMatchObject({ _tag: "Success" });
        expect(paths.some((path) => path.endsWith(`/channels/${PHOTO_CHANNEL_ID}`))).toBe(true);
        expect(paths.some((path) => path.includes("/webhooks/"))).toBe(false);
    });

    it("keeps an uninstalled guild sync nonfatal without trying to read its channel", async () => {
        let channelReads = 0;
        const layer = startupLayer((method) => {
            if (method === "GET") channelReads++;
            return Response.json({ message: "Missing access", code: 50001 }, { status: 403 });
        });
        const result = await Effect.runPromise(
            Effect.result(syncConfiguredGuild).pipe(Effect.provide(layer)),
        );
        expect(result).toMatchObject({ _tag: "Success" });
        expect(channelReads).toBe(0);
    });

    it("validates the review channel once guild synchronization succeeds", async () => {
        const layer = startupLayer((method) => {
            if (method === "PUT") return Response.json([]);
            return Response.json({ id: PHOTO_CHANNEL_ID, type: 0, guild_id: "999999999999999999" });
        });
        const result = await Effect.runPromise(
            Effect.result(syncConfiguredGuild).pipe(Effect.provide(layer)),
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "Discord.CommandsStartupError", stage: "DISCORD_NOTES_CHANNEL_ID" },
        });
    });
});
