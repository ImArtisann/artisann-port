/**
 * Attachment normalization and the stateless photo gallery.
 *
 * Uploads download only Discord-hosted attachment URLs, decode the bytes with
 * sharp (never trusting MIME or filename claims), and store a metadata-free
 * WebP in R2. Gallery interactions are stateless: every action re-reads the
 * authoritative listing from storage and renders from scratch, so buttons
 * survive restarts and a stale selection can never delete the wrong object.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { DiscordREST } from "dfx";
import type { DiscordRestService } from "dfx/DiscordREST";
import { Interaction, MessageComponentData } from "dfx/Interactions/index";
import { UI } from "dfx";
import * as Discord from "dfx/types";
import sharp from "sharp";
import { photoKey, photoUrl } from "@artisann-port/presence/photos";
import { PHOTO_TAGS } from "@artisann-port/presence/photos";
import type { Photo, PhotoTag } from "@artisann-port/presence/photos";
import { BotConfig } from "./config.ts";
import { BotPhotoClient } from "./photo-client.ts";
import {
    asJob,
    authorizeOwner,
    deferredComponentAck,
    deferredEphemeralAck,
    describeError,
    ephemeralResponse,
    PRIVATE_BOT_MESSAGE,
    queueJob,
} from "./interaction-jobs.ts";

/** Hard upload cap, enforced on the declared size and the actual bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const DISCORD_ATTACHMENT_HOSTS: readonly string[] = ["cdn.discordapp.com", "media.discordapp.net"];
const DOWNLOAD_TIMEOUT = "30 seconds";
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 1920;

/**
 * Anything wrong with an upload, in one sanitized user-facing error. The
 * cause is kept for logs only; messages never contain URLs or file names.
 */
export class AttachmentError extends Schema.TaggedError<AttachmentError>()(
    "Discord.AttachmentError",
    {
        message: Schema.String,
        cause: Schema.Defect(),
    },
) {}

/**
 * Validate an attachment URL before any network access: HTTPS only, Discord's
 * attachment CDNs, a regular or ephemeral attachment path, no credentials,
 * no custom port. Preserve signed query parameters for the download.
 * `null` means the caller answers with a validation response.
 */
export const parseAttachmentUrl = (raw: string): URL | null => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    if (!DISCORD_ATTACHMENT_HOSTS.includes(url.hostname)) return null;
    if (
        !url.pathname.startsWith("/attachments/") &&
        !url.pathname.startsWith("/ephemeral-attachments/")
    ) {
        return null;
    }
    // URL normalizes an explicit `:443` to an empty `port`, but the request
    // boundary must reject custom ports (including that explicit default).
    const authority = raw.slice("https://".length).split("/", 1)[0] ?? "";
    if (authority.includes(":") || url.port !== "") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url;
};

/**
 * Map a download failure to one sanitized attachment error. A cap breach or
 * any other error this module already authored passes through unchanged; only
 * transport failures are relabelled, and a timeout is never confused with one.
 */
const downloadFailure = (cause: unknown): AttachmentError =>
    Schema.is(AttachmentError)(cause)
        ? cause
        : new AttachmentError({
              message: Cause.isTimeoutError(cause)
                  ? "Attachment download timed out."
                  : "Attachment could not be downloaded.",
              cause: describeError(cause),
          });

/**
 * Download an attachment through the unsigned platform client with redirects
 * forbidden, collecting at most {@link MAX_ATTACHMENT_BYTES} bytes — a larger
 * body aborts mid-stream instead of buffering to disk.
 */
export const downloadAttachment = (
    client: HttpClient.HttpClient,
    url: URL,
): Effect.Effect<Buffer, AttachmentError, never> =>
    Effect.gen(function* () {
        const response = yield* client
            .execute(HttpClientRequest.get(url.href))
            .pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
                Effect.timeout(DOWNLOAD_TIMEOUT),
                Effect.mapError(downloadFailure),
            );
        if (response.status !== 200) {
            return yield* new AttachmentError({
                message: "Attachment is no longer available.",
                cause: undefined,
            });
        }
        // The parts are appended, never re-copied per chunk; the fold runs
        // once inside this effect, so the mutable accumulator cannot be shared.
        const parts: Uint8Array[] = [];
        let size = 0;
        yield* response.stream.pipe(
            Stream.runForEach((chunk) => {
                size += chunk.byteLength;
                if (size > MAX_ATTACHMENT_BYTES) {
                    return Effect.fail(
                        new AttachmentError({
                            message: "Attachments must be 20 MiB or smaller.",
                            cause: undefined,
                        }),
                    );
                }
                parts.push(chunk);
                return Effect.void;
            }),
            Effect.timeout(DOWNLOAD_TIMEOUT),
            Effect.mapError(downloadFailure),
        );
        return Buffer.concat(parts);
    });

/** The normalized upload: metadata-free WebP bytes plus decoder-measured size. */
export interface NormalizedImage {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
}

const decodeStillImage = (input: Buffer): Promise<NormalizedImage> =>
    sharp(input, {
        failOn: "warning",
        limitInputPixels: MAX_PIXELS,
    })
        .metadata()
        .then((metadata) => {
            const formatAllowed =
                metadata.format === "jpeg" ||
                metadata.format === "png" ||
                metadata.format === "webp" ||
                (metadata.format === "heif" &&
                    metadata.compression === "av1" &&
                    metadata.mediaType === "image/avif");
            if (!formatAllowed) {
                throw new Error("only JPEG, PNG, WebP and AVIF images are accepted");
            }
            if (metadata.pages !== undefined && metadata.pages > 1) {
                throw new Error("animated or multi-page images are not supported");
            }
            return sharp(input, { failOn: "warning", limitInputPixels: MAX_PIXELS })
                .autoOrient()
                .resize({
                    width: MAX_DIMENSION,
                    height: MAX_DIMENSION,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: 82 })
                .toBuffer({ resolveWithObject: true })
                .then((output) => {
                    if (output.info.format !== "webp") {
                        throw new Error("encoder produced an unexpected format");
                    }
                    return {
                        bytes: output.data,
                        width: output.info.width,
                        height: output.info.height,
                    };
                });
        });

/** Decode and normalize one image's bytes; rejects everything non-still-image. */
export const normalizeImage = (
    bytes: Uint8Array,
): Effect.Effect<NormalizedImage, AttachmentError> =>
    Effect.tryPromise({
        try: () => {
            const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            return decodeStillImage(input);
        },
        catch: (cause) =>
            new AttachmentError({
                message: "That file could not be read as a still image.",
                cause,
            }),
    });

/**
 * Image normalization serialized behind one permit, so parallel owner
 * commands cannot exhaust VPS memory decoding several images at once.
 */
export interface ImageNormalizerService {
    readonly normalize: (bytes: Uint8Array) => Effect.Effect<NormalizedImage, AttachmentError>;
}

export class ImageNormalizer extends Context.Service<ImageNormalizer, ImageNormalizerService>()(
    "@artisann-port/discord/ImageNormalizer",
) {}

export const ImageNormalizerLive: Layer.Layer<ImageNormalizer> = Layer.effect(
    ImageNormalizer,
    Effect.map(Semaphore.make(1), (semaphore) => ({
        normalize: (bytes: Uint8Array) => semaphore.withPermits(1)(normalizeImage(bytes)),
    })),
);

// === Gallery custom ids: `photos:<tag>:<action>:<photoId>` ==================

export type PhotoGalleryAction = "prev" | "next" | "select" | "delete" | "confirm" | "cancel";

const PHOTO_GALLERY_ACTIONS: readonly PhotoGalleryAction[] = [
    "prev",
    "next",
    "select",
    "delete",
    "confirm",
    "cancel",
];

export const photosCustomId = (
    tag: PhotoTag,
    action: PhotoGalleryAction,
    photoId: string,
): string => `photos:${tag}:${action}:${photoId}`;

export interface ParsedPhotosCustomId {
    readonly tag: PhotoTag;
    readonly action: PhotoGalleryAction;
    readonly photoId: string;
}

/** Full grammar + Discord's 100-character custom-id limit; `null` when invalid. */
export const parsePhotosCustomId = (customId: string): ParsedPhotosCustomId | null => {
    if (customId.length > 100) return null;
    const parts = customId.split(":");
    if (parts.length !== 4 || parts[0] !== "photos") return null;
    const tag = PHOTO_TAGS.find((candidate) => candidate === parts[1]);
    const action = PHOTO_GALLERY_ACTIONS.find((candidate) => candidate === parts[2]);
    const photoId = parts[3];
    if (tag === undefined || action === undefined || photoId === undefined || photoId === "")
        return null;
    return { tag, action, photoId };
};

/** The interaction id embedded in a managed photo key, or `null`. */
export const photoIdFromKey = (tag: PhotoTag, key: string): string | null => {
    const prefix = `${tag}/`;
    if (!key.startsWith(prefix) || !key.endsWith(".webp")) return null;
    const id = key.slice(prefix.length, key.length - ".webp".length);
    return photoKey(tag, id) === key ? id : null;
};

// === Gallery rendering =======================================================

/**
 * A fully rendered gallery message. `content` carries notices and the
 * empty-folder message; `embeds`/`components` are empty when there is nothing
 * to show (never a zero-option select).
 */
export interface GalleryPayload {
    readonly content: string | null;
    readonly embeds: ReadonlyArray<Discord.RichEmbed>;
    readonly components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
}

const emptyGalleryPayload = (tag: PhotoTag): GalleryPayload => ({
    content: `No ${tag} photos yet — use \`/photos upload\` to add some.`,
    embeds: [],
    components: [],
});

/**
 * Render the stateless gallery for one tag. Navigation is computed from the
 * fresh listing; `activeId` falls back to the first photo when it is gone
 * (the caller attaches a "gallery changed" notice).
 */
export const renderGallery = (
    tag: PhotoTag,
    photos: readonly Photo[],
    activeId: string | null,
    notice: string | null,
): GalleryPayload => {
    if (photos.length === 0) return emptyGalleryPayload(tag);
    const index =
        activeId === null
            ? 0
            : Math.max(
                  0,
                  photos.findIndex((photo) => photoIdFromKey(tag, photo.key) === activeId),
              );
    const active = photos[index];
    if (active === undefined) return emptyGalleryPayload(tag);
    const activeIdResolved = photoIdFromKey(tag, active.key);
    if (activeIdResolved === null) return emptyGalleryPayload(tag);

    const embed: Discord.RichEmbed = {
        image: { url: active.url },
        title: tag === "life" ? "Life photos" : "Cat photos",
        timestamp: active.uploadedAt,
        footer: { text: `${index + 1} / ${photos.length} — id ${activeIdResolved}` },
    };

    const blockStart = Math.floor(index / 25) * 25;
    const selectOptions: Discord.StringSelectOptionForRequest[] = [];
    for (let offset = 0; offset < 25 && blockStart + offset < photos.length; offset++) {
        const photo = photos[blockStart + offset];
        const id = photo === undefined ? null : photoIdFromKey(tag, photo.key);
        if (photo === undefined || id === null) continue;
        const option: Discord.StringSelectOptionForRequest = {
            label: `#${blockStart + offset + 1} — ${photo.uploadedAt}`,
            value: id,
            default: id === activeIdResolved,
        };
        selectOptions.push(option);
    }
    const selectRow: Discord.ActionRowComponentForMessageRequest = {
        type: 1,
        components: [
            UI.select({
                custom_id: photosCustomId(tag, "select", activeIdResolved),
                options: selectOptions,
            }),
        ],
    };
    const navRow = UI.row([
        UI.button({
            custom_id: photosCustomId(tag, "prev", activeIdResolved),
            label: "Previous",
            style: 2,
            disabled: photos.length === 1,
        }),
        UI.button({
            custom_id: photosCustomId(tag, "next", activeIdResolved),
            label: "Next",
            style: 2,
            disabled: photos.length === 1,
        }),
        UI.button({
            custom_id: photosCustomId(tag, "delete", activeIdResolved),
            label: "Delete",
            style: 4,
        }),
    ]);

    return {
        content: notice,
        embeds: [embed],
        components: [selectRow, navRow],
    };
};

/** The explicit delete confirmation for one photo; no storage effect. */
export const renderDeleteConfirmation = (
    tag: PhotoTag,
    photo: Photo,
    photoId: string,
): GalleryPayload => ({
    content: null,
    embeds: [
        {
            image: { url: photo.url },
            title: `Delete this ${tag} photo?`,
            timestamp: photo.uploadedAt,
            footer: { text: `id ${photoId}` },
        },
    ],
    components: [
        UI.row([
            UI.button({
                custom_id: photosCustomId(tag, "confirm", photoId),
                label: "Confirm delete",
                style: 4,
            }),
            UI.button({
                custom_id: photosCustomId(tag, "cancel", photoId),
                label: "Cancel",
                style: 2,
            }),
        ]),
    ],
});

const toPatchPayload = (payload: GalleryPayload): Discord.IncomingWebhookUpdateRequestPartial => ({
    content: payload.content ?? "",
    embeds: payload.embeds,
    components: payload.components,
    allowed_mentions: { parse: [] },
});

/** Immediate ephemeral gallery message (type 4) — unused for deferred flows. */
export const galleryMessageResponse = (
    payload: GalleryPayload,
): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
        content: payload.content ?? "",
        embeds: payload.embeds,
        components: payload.components,
        flags: Discord.MessageFlags.Ephemeral,
        allowed_mentions: { parse: [] },
    },
});

// === Flows ===================================================================

interface Reporter {
    readonly rest: DiscordRestService;
    readonly clientId: string;
}

const patchGallery = (
    reporter: Reporter,
    interaction: Discord.APIInteraction,
    payload: GalleryPayload,
) =>
    reporter.rest.updateOriginalWebhookMessage(reporter.clientId, interaction.token, {
        payload: toPatchPayload(payload),
    });

/**
 * `/photos upload`: validate the attachment, ACK ephemerally, then queue the
 * download → normalize → R2 put job that reports the public URL.
 */
export const uploadPhotoFlow = Effect.fn("Photos.uploadFlow")(function* (
    interaction: Discord.APIInteraction,
    tag: PhotoTag,
    attachment: Discord.AttachmentResponse,
) {
    const config = yield* BotConfig;
    const photoClient = yield* BotPhotoClient;
    const normalizer = yield* ImageNormalizer;
    const client = yield* HttpClient.HttpClient;
    const rest = yield* DiscordREST;
    const reporter: Reporter = { rest, clientId: config.clientId };

    const url = parseAttachmentUrl(attachment.url);
    if (url === null) {
        return ephemeralResponse(
            "Attach an image hosted by Discord (cdn.discordapp.com or media.discordapp.net).",
        );
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return ephemeralResponse("Attachments must be 20 MiB or smaller.");
    }

    const interactionId = interaction.id;
    yield* queueJob(
        asJob(
            reporter,
            interaction,
            Effect.gen(function* () {
                const bytes = yield* downloadAttachment(client, url);
                const normalized = yield* normalizer.normalize(bytes);
                const key = yield* photoClient.putPhoto(tag, interactionId, normalized.bytes);
                const publicUrl = photoUrl(key, config.assetsHost);
                if (publicUrl === null) {
                    return yield* new AttachmentError({
                        message: "The configured assets host is invalid.",
                        cause: undefined,
                    });
                }
                yield* patchGallery(reporter, interaction, {
                    content: `Uploaded a ${tag} photo: ${publicUrl}`,
                    embeds: [{ image: { url: publicUrl } }],
                    components: [],
                });
            }),
        ),
    );
    return deferredEphemeralAck;
});

/**
 * `/photos browse`: ACK ephemerally, then queue a job that reads the fresh
 * listing and renders the gallery (or the explicit empty folder message).
 */
export const browsePhotosFlow = Effect.fn("Photos.browseFlow")(function* (
    interaction: Discord.APIInteraction,
    tag: PhotoTag,
) {
    const config = yield* BotConfig;
    const photoClient = yield* BotPhotoClient;
    const rest = yield* DiscordREST;
    const reporter: Reporter = { rest, clientId: config.clientId };

    yield* queueJob(
        asJob(
            reporter,
            interaction,
            Effect.gen(function* () {
                const photos = yield* photoClient.listPhotos(tag);
                yield* patchGallery(reporter, interaction, renderGallery(tag, photos, null, null));
            }),
        ),
    );
    return deferredEphemeralAck;
});

/**
 * Every `photos:` component: revalidate owner/guild, reread the fresh
 * listing, and act on the exact photo id in the custom id — never a position.
 */
export const handlePhotosComponent = Effect.gen(function* () {
    if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const interaction = yield* Interaction;
    const data = yield* MessageComponentData;
    const config = yield* BotConfig;
    const photoClient = yield* BotPhotoClient;
    const rest = yield* DiscordREST;
    const reporter: Reporter = { rest, clientId: config.clientId };

    const parsed = parsePhotosCustomId(data.custom_id);
    if (parsed === null) return ephemeralResponse("Unknown photo action.");

    const chosenFromSelect = "values" in data ? (data.values[0] ?? null) : null;
    const tag = parsed.tag;

    const job = Effect.gen(function* () {
        const photos = yield* photoClient.listPhotos(tag);
        const indexOf = (photoId: string | null) =>
            photoId === null
                ? -1
                : photos.findIndex((photo) => photoIdFromKey(tag, photo.key) === photoId);

        switch (parsed.action) {
            case "prev":
            case "next": {
                const delta = parsed.action === "prev" ? -1 : 1;
                const current = indexOf(parsed.photoId);
                if (photos.length === 0) {
                    yield* patchGallery(reporter, interaction, emptyGalleryPayload(tag));
                    return;
                }
                if (current === -1) {
                    yield* patchGallery(
                        reporter,
                        interaction,
                        renderGallery(
                            tag,
                            photos,
                            null,
                            "The gallery changed — showing the newest photo.",
                        ),
                    );
                    return;
                }
                const target = (current + photos.length + delta) % photos.length;
                const targetId = photoIdFromKey(tag, photos[target]!.key);
                yield* patchGallery(
                    reporter,
                    interaction,
                    renderGallery(tag, photos, targetId, null),
                );
                return;
            }
            case "select": {
                const chosen =
                    chosenFromSelect !== null && indexOf(chosenFromSelect) !== -1
                        ? chosenFromSelect
                        : null;
                yield* patchGallery(
                    reporter,
                    interaction,
                    renderGallery(
                        tag,
                        photos,
                        chosen,
                        chosen === null
                            ? "That photo is no longer in the gallery — showing the newest."
                            : null,
                    ),
                );
                return;
            }
            case "delete": {
                const photo = photos[indexOf(parsed.photoId)];
                if (photo === undefined) {
                    yield* patchGallery(
                        reporter,
                        interaction,
                        renderGallery(
                            tag,
                            photos,
                            null,
                            "That photo was already deleted — showing the newest.",
                        ),
                    );
                    return;
                }
                const photoId = photoIdFromKey(tag, photo.key);
                if (photoId === null) {
                    return yield* new AttachmentError({
                        message: "Stored photo key is invalid.",
                        cause: undefined,
                    });
                }
                yield* patchGallery(
                    reporter,
                    interaction,
                    renderDeleteConfirmation(tag, photo, photoId),
                );
                return;
            }
            case "confirm": {
                if (photoKey(tag, parsed.photoId) === null) {
                    yield* patchGallery(
                        reporter,
                        interaction,
                        renderGallery(
                            tag,
                            photos,
                            null,
                            "That photo was already deleted — showing the newest.",
                        ),
                    );
                    return;
                }
                if (indexOf(parsed.photoId) === -1) {
                    yield* patchGallery(
                        reporter,
                        interaction,
                        renderGallery(
                            tag,
                            photos,
                            null,
                            "Already deleted — showing the newest photo.",
                        ),
                    );
                    return;
                }
                yield* photoClient.deletePhoto(tag, parsed.photoId);
                const remaining = yield* photoClient.listPhotos(tag);
                yield* patchGallery(
                    reporter,
                    interaction,
                    renderGallery(tag, remaining, null, null),
                );
                return;
            }
            case "cancel": {
                yield* patchGallery(
                    reporter,
                    interaction,
                    renderGallery(
                        tag,
                        photos,
                        indexOf(parsed.photoId) === -1 ? null : parsed.photoId,
                        null,
                    ),
                );
                return;
            }
        }
    });

    // Failures fall through to `asJob`, which reports them by editing the
    // deferred response — a silent gallery is never left behind.
    yield* queueJob(asJob(reporter, interaction, job));
    return deferredComponentAck;
});
