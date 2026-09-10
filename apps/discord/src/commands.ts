/**
 * The owner-only command surface and the interaction runtime.
 *
 * This module owns three things:
 *
 * 1. the guild command definitions and the extraction of their subcommand
 *    path, options and resolved attachments — everything a handler needs
 *    before it may touch storage;
 * 2. the registration of every component, modal and autocomplete handler,
 *    delegating to the flows that own each surface (`./cms.ts`, `./photos.ts`,
 *    `./notes.ts`);
 * 3. `CommandsLive`: startup verification, explicit single-guild command
 *    synchronization, and the dfx `runIx` wiring whose `postHandler` forks a
 *    queued job only after Discord confirmed the interaction response.
 *
 * Authorization happens before any provider access: a slash command from
 * anywhere but the configured guild/owner pair answers with one ephemeral
 * denial and performs no Cloudflare, R2 or attachment request. The component,
 * modal and autocomplete handlers repeat the check themselves, because they
 * arrive as independent interactions.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { DiscordREST, Ix, IxHelpers } from "dfx";
import { DiscordGateway, interactionsSync, runIx } from "dfx/gateway";
import type { DiscordRESTError } from "dfx/DiscordREST";
import type { DefinitionNotFound } from "dfx/Interactions/handlers";
import * as Discord from "dfx/types";
import { PHOTO_TAGS } from "@artisann-port/presence/photos";
import { BotConfig } from "./config.ts";
import { BotContentClient } from "./content-client.ts";
import { BotPhotoClient } from "./photo-client.ts";
import { cmsEntryFlow, handleCmsComponent, handleCmsModal, recordsFlow, usesFlow } from "./cms.ts";
import {
    authorizeOwner,
    ephemeralResponse,
    makePostHandler,
    PendingInteractionJob,
    PRIVATE_BOT_MESSAGE,
} from "./interaction-jobs.ts";
import { NoteModerationLive, noteDecisionHandler, verifyNotesWebhook } from "./notes.ts";
import { browseNotesFlow, deleteNoteFlow, handleNotesComponent } from "./notes-command.ts";
import {
    browsePhotosFlow,
    handlePhotosComponent,
    ImageNormalizerLive,
    uploadPhotoFlow,
} from "./photos.ts";

/** Command synchronization or identity verification refused to start. */
export class CommandsStartupError extends Schema.TaggedError<CommandsStartupError>()(
    "Discord.CommandsStartupError",
    { stage: Schema.String, reason: Schema.String },
) {}

/** Answer for an interaction whose required option Discord did not send. */
const MISSING_OPTION = ephemeralResponse("That command was missing required input.");

/**
 * Picker entries for the gallery option, derived from the shared tag list so a
 * new gallery cannot be validated by the bot yet missing from the choices.
 */
const PHOTO_TAG_CHOICES = PHOTO_TAGS.map((tag) => ({
    name: `${tag.charAt(0).toUpperCase()}${tag.slice(1)}`,
    value: tag,
}));

/** Answer for a subcommand this build does not implement. */
const UNKNOWN_SUBCOMMAND = ephemeralResponse("That command is not available.");

/** Answer for an attachment option whose upload Discord did not resolve. */
const MISSING_ATTACHMENT = ephemeralResponse("Attach an image and run the command again.");

// ===========================================================================
// Command invocation shape
// ===========================================================================

/**
 * One invocation reduced to its subcommand path and the options that belong to
 * leaf. `/apps add` yields `["add"]` with the leaf's own options;
 * `/records` yields an empty path.
 */
export interface CommandInvocation {
    readonly path: ReadonlyArray<string>;
    readonly options: ReadonlyArray<Discord.APIApplicationCommandInteractionDataOption>;
}

/**
 * Walk the option tree down to the invoked leaf. Subcommands and groups are
 * the only options without a `value`, and Discord sends exactly one of them
 * per level, so the descent is unambiguous — dfx's own flattening is not used
 * here because it loses the invoked subcommand path.
 */
export const commandInvocation = (
    data: Discord.APIApplicationCommandInteraction["data"],
): CommandInvocation => {
    const path: Array<string> = [];
    let options: ReadonlyArray<Discord.APIApplicationCommandInteractionDataOption> =
        "options" in data ? (data.options ?? []) : [];
    while (options.length === 1) {
        const only = options[0];
        if (only === undefined || "value" in only) break;
        path.push(only.name);
        options = only.options ?? [];
    }
    return { path, options };
};

/**
 * Options whose value is a plain string: the STRING options and the snowflake
 * an ATTACHMENT option carries. Numbers and booleans decode as absent.
 */
const StringValuedOption = Schema.Struct({ value: Schema.String });
const decodeStringValuedOption = Schema.decodeUnknownOption(StringValuedOption);

/** One option's string value, or `null` when it is absent or another type. */
export const stringOption = (invocation: CommandInvocation, name: string): string | null => {
    const option = invocation.options.find((candidate) => candidate.name === name);
    if (option === undefined) return null;
    const decoded = decodeStringValuedOption(option);
    return Option.isSome(decoded) ? decoded.value.value : null;
};

/**
 * The attachment an option points at, read from the interaction's resolved
 * data. dfx's `CommandHelper.resolve` excludes attachments from its resolvable
 * types, so the lookup goes through the untyped-safe helper instead.
 */
export const attachmentOption = (
    interaction: Discord.APIInteraction,
    invocation: CommandInvocation,
    name: string,
): Discord.AttachmentResponse | null => {
    const id = stringOption(invocation, name);
    if (id === null) return null;
    const resolved = IxHelpers.resolved(interaction);
    if (Option.isNone(resolved)) return null;
    return resolved.value.attachments?.[id] ?? null;
};

/** The three list sections that share the add / edit / remove shapes. */
type EntryAction = "add" | "edit" | "remove";

const entryAction = (name: string | undefined): EntryAction | null =>
    name === "add" || name === "edit" || name === "remove" ? name : null;

// ===========================================================================
// Command definitions
// ===========================================================================

/** The add / edit / remove subcommands every editable list section shares. */
const entrySubcommands = (singular: string) =>
    [
        { type: 1, name: "add", description: `Add ${singular}` },
        { type: 1, name: "edit", description: `Edit ${singular}` },
        { type: 1, name: "remove", description: `Remove ${singular}` },
    ] as const;

const recordsCommand = Ix.guild(
    { name: "records", description: "Edit the personal records shown on the site" },
    () =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            return yield* recordsFlow(yield* Ix.Interaction);
        }),
);

const usesCommand = Ix.guild(
    { name: "uses", description: "Edit the software, hardware and languages lists" },
    () =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            return yield* usesFlow(yield* Ix.Interaction);
        }),
);

const experienceCommand = Ix.guild(
    {
        name: "experience",
        description: "Edit work experience shown on the site",
        options: entrySubcommands("an experience entry"),
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const action = entryAction(commandInvocation(helper.data).path[0]);
            if (action === null) return UNKNOWN_SUBCOMMAND;
            return yield* cmsEntryFlow(yield* Ix.Interaction, "experience", action);
        }),
);

const factsCommand = Ix.guild(
    {
        name: "facts",
        description: "Edit personal facts shown on the site",
        options: entrySubcommands("a personal fact"),
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const action = entryAction(commandInvocation(helper.data).path[0]);
            if (action === null) return UNKNOWN_SUBCOMMAND;
            return yield* cmsEntryFlow(yield* Ix.Interaction, "facts", action);
        }),
);

const appsCommand = Ix.guild(
    {
        name: "apps",
        description: "Manage the deployed apps section",
        options: [...entrySubcommands("a deployed app")],
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const invocation = commandInvocation(helper.data);
            const action = entryAction(invocation.path[0]);
            if (action === null) return UNKNOWN_SUBCOMMAND;
            return yield* cmsEntryFlow(yield* Ix.Interaction, "apps", action);
        }),
);

const openSourceCommand = Ix.guild(
    {
        name: "opensource",
        description: "Manage the open-source projects section",
        options: entrySubcommands("an open-source project"),
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const action = entryAction(commandInvocation(helper.data).path[0]);
            if (action === null) return UNKNOWN_SUBCOMMAND;
            return yield* cmsEntryFlow(yield* Ix.Interaction, "opensource", action);
        }),
);

const socialsCommand = Ix.guild(
    {
        name: "socials",
        description: "Manage the social links section",
        options: entrySubcommands("a social link"),
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const action = entryAction(commandInvocation(helper.data).path[0]);
            if (action === null) return UNKNOWN_SUBCOMMAND;
            return yield* cmsEntryFlow(yield* Ix.Interaction, "socials", action);
        }),
);

const photosCommand = Ix.guild(
    {
        name: "photos",
        description: "Upload and manage the public photo galleries",
        options: [
            {
                type: 1,
                name: "upload",
                description: "Upload one photo to a gallery",
                options: [
                    {
                        type: 3,
                        name: "tag",
                        description: "Which gallery",
                        required: true,
                        choices: PHOTO_TAG_CHOICES,
                    },
                    {
                        type: 11,
                        name: "image",
                        description: "The photo to upload",
                        required: true,
                    },
                ],
            },
            {
                type: 1,
                name: "browse",
                description: "Browse a gallery and delete photos",
                options: [
                    {
                        type: 3,
                        name: "tag",
                        description: "Which gallery",
                        required: true,
                        choices: PHOTO_TAG_CHOICES,
                    },
                ],
            },
        ],
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const interaction = yield* Ix.Interaction;
            const invocation = commandInvocation(helper.data);
            const value = stringOption(invocation, "tag");
            const tag = PHOTO_TAGS.find((candidate) => candidate === value) ?? null;
            if (tag === null) return MISSING_OPTION;
            if (invocation.path[0] === "upload") {
                const attachment = attachmentOption(interaction, invocation, "image");
                if (attachment === null) return MISSING_ATTACHMENT;
                return yield* uploadPhotoFlow(interaction, tag, attachment);
            }
            if (invocation.path[0] === "browse") {
                return yield* browsePhotosFlow(interaction, tag);
            }
            return UNKNOWN_SUBCOMMAND;
        }),
);

const notesCommand = Ix.guild(
    {
        name: "notes",
        description: "Browse and delete approved visitor notes",
        options: [
            {
                type: 1,
                name: "list",
                description: "Browse approved notes and delete them",
            },
            {
                type: 1,
                name: "delete",
                description: "Delete an approved note by id",
                options: [
                    {
                        type: 3,
                        name: "id",
                        description: "The note id shown by /notes list",
                        required: true,
                    },
                ],
            },
        ],
    },
    (helper) =>
        Effect.gen(function* () {
            if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
            const interaction = yield* Ix.Interaction;
            const invocation = commandInvocation(helper.data);
            if (invocation.path[0] === "list") return yield* browseNotesFlow(interaction);
            if (invocation.path[0] === "delete") {
                const id = stringOption(invocation, "id");
                return id === null ? MISSING_OPTION : yield* deleteNoteFlow(interaction, id);
            }
            return UNKNOWN_SUBCOMMAND;
        }),
);

// ===========================================================================
// The interaction surface
// ===========================================================================

/**
 * Every definition this bot answers. Components and modals are routed by
 * custom-id prefix; entry selection uses the picker component, so no command
 * declares an autocompleted option.
 */
export const commandDefinitions = Ix.builder
    .add(recordsCommand)
    .add(usesCommand)
    .add(experienceCommand)
    .add(factsCommand)
    .add(appsCommand)
    .add(openSourceCommand)
    .add(socialsCommand)
    .add(photosCommand)
    .add(notesCommand)
    .add(Ix.messageComponent(Ix.idStartsWith("notes:"), handleNotesComponent))
    .add(Ix.messageComponent(Ix.idStartsWith("photos:"), handlePhotosComponent))
    .add(Ix.messageComponent(Ix.idStartsWith("cms:"), handleCmsComponent))
    .add(noteDecisionHandler)
    .add(Ix.modalSubmit(Ix.idStartsWith("cms:"), handleCmsModal));

/**
 * The context and error of one fully routed interaction, read off the builder
 * so the post-handler is a concrete function: dfx infers `runIx`'s parameters
 * from the post-handler alone, and a generic one leaves them unresolved.
 */
type DefinitionServices =
    typeof commandDefinitions extends Ix.InteractionBuilder<infer R, infer _E, infer _TE>
        ? R
        : never;
type DefinitionError =
    typeof commandDefinitions extends Ix.InteractionBuilder<infer _R, infer E, infer _TE>
        ? E
        : never;
type DefinitionTransformError =
    typeof commandDefinitions extends Ix.InteractionBuilder<infer _R, infer _E, infer TE>
        ? TE
        : never;

type HandlerServices = DefinitionServices | DiscordREST | Ix.Interaction;
type HandlerError = DefinitionTransformError | DefinitionNotFound;

// ===========================================================================
// Startup verification and guild synchronization
// ===========================================================================

/** The HTTP status a dfx REST failure carries, when a response was received. */
const restStatus = (error: DiscordRESTError): number | null => error.response?.status ?? null;

/** The status suffix a sanitized log line or startup reason carries. */
const statusSuffix = (error: DiscordRESTError): string => {
    const status = restStatus(error);
    return status === null ? "" : ` (HTTP ${status})`;
};

/**
 * Verify the authenticated application matches the configured client id.
 * A mismatch or an unreadable application is a startup error: every later
 * request would target the wrong application.
 */
const verifyApplication = Effect.gen(function* () {
    const config = yield* BotConfig;
    const rest = yield* DiscordREST;
    const application = yield* rest.getMyApplication().pipe(
        Effect.mapError(
            (error) =>
                new CommandsStartupError({
                    stage: "DISCORD_BOT_TOKEN",
                    reason: `the application could not be read${statusSuffix(error)}`,
                }),
        ),
    );
    if (application.id !== config.clientId) {
        return yield* new CommandsStartupError({
            stage: "DISCORD_BOT_CLIENT_ID",
            reason: "does not match the authenticated application",
        });
    }
});

/**
 * Register this bot's commands in the configured guild only — never globally
 * and never in other joined guilds.
 *
 * A 403/404 means the application is not installed there yet: that is not a
 * failure, the Gateway listener stays alive and `GUILD_CREATE` re-runs the
 * sync when the bot is added. Every other status is reported, so an outage is
 * never mistaken for an uninstalled application.
 */
export const syncConfiguredGuild = Effect.gen(function* () {
    const config = yield* BotConfig;
    const outcome = yield* Effect.result(
        commandDefinitions.syncGuild(config.clientId, config.serverId),
    );
    if (outcome._tag === "Success") {
        const rest = yield* DiscordREST;
        const channel = yield* rest.getChannel(config.notesChannelId).pipe(
            Effect.mapError(
                () =>
                    new CommandsStartupError({
                        stage: "DISCORD_NOTES_CHANNEL_ID",
                        reason: "the review channel could not be read",
                    }),
            ),
        );
        if (
            channel.type !== 0 ||
            !("guild_id" in channel) ||
            channel.guild_id !== config.serverId
        ) {
            return yield* new CommandsStartupError({
                stage: "DISCORD_NOTES_CHANNEL_ID",
                reason: "must be a text channel inside DISCORD_SERVER_ID",
            });
        }
        return;
    }
    const status = restStatus(outcome.failure);
    if (status === 403 || status === 404) {
        yield* Effect.logWarning(
            "Commands: the bot is not installed in the configured guild yet; " +
                "invite it and the commands register on GUILD_CREATE",
        );
        return;
    }
    yield* Effect.logError(
        `Commands: registering the guild commands failed${statusSuffix(outcome.failure)}`,
    );
});

// ===========================================================================
// The worker layer
// ===========================================================================

/**
 * The command runtime: verify identity, register the guild commands, and run
 * the interaction loop for the lifetime of the application scope.
 *
 * `interactionsSync` is disabled so dfx never registers global commands or
 * walks every joined guild; synchronization is the explicit call above.
 * Queued jobs are forked into this layer's scope by the post-handler, so a
 * mutation outlives its handler but never the process.
 */
export const CommandsLive: Layer.Layer<
    never,
    CommandsStartupError,
    | BotConfig
    | BotContentClient
    | BotPhotoClient
    | DiscordREST
    | DiscordGateway
    | HttpClient.HttpClient
> = Layer.effectDiscard(
    Effect.gen(function* () {
        const config = yield* BotConfig;
        const gateway = yield* DiscordGateway;

        // Both verifications run before a single command is registered.
        yield* verifyApplication;
        yield* verifyNotesWebhook.pipe(
            Effect.mapError(
                (error) => new CommandsStartupError({ stage: error.field, reason: error.reason }),
            ),
        );

        // Jobs are forked here, not in the per-interaction scope dfx closes
        // as soon as the response POST returns.
        const appScope = yield* Effect.scope;
        const forkQueuedJob = makePostHandler(appScope);
        const postHandler = (
            respond: Effect.Effect<void, HandlerError, HandlerServices>,
        ): Effect.Effect<void, never, Exclude<HandlerServices, PendingInteractionJob>> =>
            forkQueuedJob(respond);
        // Explicit type arguments: dfx infers `run`'s parameters from the
        // post-handler alone, and its `R | DiscordREST | Interaction` shape
        // would otherwise subtract services the definitions genuinely need.
        const interactions = runIx<
            DefinitionServices,
            Exclude<HandlerServices, PendingInteractionJob>,
            DefinitionError,
            DefinitionTransformError,
            never
        >(postHandler)(commandDefinitions).pipe(Effect.provideService(interactionsSync, false));

        yield* Effect.forkScoped(
            interactions.pipe(
                // dfx REST errors carry the authenticated request and the raw
                // response, so only a sanitized status reaches the log.
                Effect.tapError((error) =>
                    Effect.logError(`Commands: the interaction loop failed${statusSuffix(error)}`),
                ),
                Effect.retry(Schedule.spaced("5 seconds")),
                // Only a defect reaches this: retries above are unbounded.
                Effect.catchCause(() =>
                    Effect.logError("Commands: the interaction loop ended unexpectedly"),
                ),
            ),
        );

        yield* syncConfiguredGuild;
        yield* Effect.forkScoped(
            gateway.handleDispatch("GUILD_CREATE", (guild) =>
                guild.id === config.serverId && !guild.unavailable
                    ? syncConfiguredGuild.pipe(
                          Effect.catch((error) =>
                              Effect.logError(`Commands: ${error.stage}: ${error.reason}`),
                          ),
                      )
                    : Effect.void,
            ),
        );
    }),
).pipe(Layer.provide(Layer.mergeAll(ImageNormalizerLive, NoteModerationLive)));
