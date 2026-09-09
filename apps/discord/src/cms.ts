/**
 * Site-content editing: the modals, pickers, confirmations and queued
 * mutations behind `/records`, `/uses`, `/apps`, `/opensource`, `/socials`,
 * `/experience`, and `/facts`.
 *
 * Three rules shape every flow here:
 *
 * 1. **Nothing is written from a stale read.** A read only decides what to
 *    show; every mutation is expressed as a change function that the content
 *    client applies to the document it just read
 *    from the authoritative writer. An entry that disappeared in between
 *    fails the change instead of being resurrected by a whole-document
 *    overwrite.
 * 2. **Only storage work is deferred.** Validation, grammar checks and
 *    authorization answer immediately (type 4/7/9 responses) and touch no
 *    storage; anything that writes ACKs first and runs as a
 *    {@link queueJob} job that reports by editing the original response.
 * 3. **Uncertainty is never treated as success.** Unclear writer failures are
 *    reported without pretending a document mutation committed.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { DiscordREST, UI } from "dfx";
import type { DiscordRestService } from "dfx/DiscordREST";
import {
    Interaction,
    MessageComponentData,
    ModalSubmitData,
    focusedOptionValue,
} from "dfx/Interactions/index";
import * as Discord from "dfx/types";
import {
    HttpsUrl,
    LinkUrl,
    MAX_APPS,
    MAX_EXPERIENCE,
    MAX_FACTS,
    MAX_OPEN_SOURCE,
    FACT_ICONS,
    MAX_SOCIALS,
    MAX_USE_ITEMS,
    RecordValue,
    SOCIAL_ICONS,
    formatUseLines,
    parseUseLines,
} from "@artisann-port/presence/content";
import { parseOgImageHosts } from "@artisann-port/presence/project-hosts";
import type {
    DeployedApp,
    OpenSourceProject,
    PersonalRecords,
    FactIcon,
    PersonalFact,
    WorkExperience,
    SiteContent,
    SocialIcon,
    SocialLink,
    UseItem,
    Uses,
} from "@artisann-port/presence/content";
import { BotConfig } from "./config.ts";
import type { BotConfigService } from "./config.ts";
import { ContentValidationError } from "./rpc-client.ts";
import { BotContentClient } from "./content-client.ts";
import type { BotContentClientService } from "./content-client.ts";
import type { BotStorageError } from "./rpc-client.ts";
import type { ModalField } from "./modal.ts";
import { modalFields, selectValues, textField } from "./modal.ts";
import {
    MISSING_ENTRY_MESSAGE,
    PRIVATE_BOT_MESSAGE,
    asJob,
    deferredComponentAck,
    deferredEphemeralAck,
    ephemeralResponse,
    queueJob,
} from "./interaction-jobs.ts";

// === Custom-id grammar: `cms:<section>:<action>[:<id>]` ======================

/** Every content area addressable from a custom id. */
export type CmsSection =
    | "records"
    | "uses"
    | "apps"
    | "opensource"
    | "socials"
    | "experience"
    | "facts";

/** The list sections that share the add / pick-then-edit / pick-then-remove shape. */
export type EntrySection = "apps" | "opensource" | "socials" | "experience" | "facts";

/** Every action a `cms:` custom id may carry. */
export type CmsAction =
    | "add"
    | "edit"
    | "pick-edit"
    | "pick-remove"
    | "remove"
    | "confirm"
    | "cancel"
    | "pick";

const CMS_SECTIONS: readonly CmsSection[] = [
    "records",
    "uses",
    "apps",
    "opensource",
    "socials",
    "experience",
    "facts",
];

const CMS_ACTIONS: readonly CmsAction[] = [
    "add",
    "edit",
    "pick-edit",
    "pick-remove",
    "remove",
    "confirm",
    "cancel",
    "pick",
];

/** Discord's hard limit on a custom id, validated on every interaction. */
const MAX_CUSTOM_ID = 100;

/** Select menus offer at most 25 options; every list section is capped to match. */
const MAX_PICKER_OPTIONS = 25;

/** Select-menu labels and autocomplete names are capped at 100 characters. */
const MAX_CHOICE_TEXT = 100;

/** The shared `EntryId` pattern, applied to every id inside a custom id. */
const ENTRY_ID = /^[a-z0-9-]{1,32}$/u;

export interface ParsedCmsCustomId {
    readonly section: CmsSection;
    readonly action: CmsAction;
    /** The entry id, or `null` for section-wide actions. */
    readonly id: string | null;
}

/** Build a custom id; `id` is omitted from the grammar when `null`. */
export const cmsCustomId = (section: CmsSection, action: CmsAction, id: string | null): string =>
    id === null ? `cms:${section}:${action}` : `cms:${section}:${action}:${id}`;

/**
 * Validate a custom id completely — prefix, section, action, id shape and
 * Discord's 100-character limit. `null` means the caller answers with a
 * validation response and touches no storage.
 */
export const parseCmsCustomId = (customId: string): ParsedCmsCustomId | null => {
    if (customId.length > MAX_CUSTOM_ID) return null;
    const parts = customId.split(":");
    if (parts[0] !== "cms") return null;
    const section = CMS_SECTIONS.find((candidate) => candidate === parts[1]);
    const action = CMS_ACTIONS.find((candidate) => candidate === parts[2]);
    if (section === undefined || action === undefined) return null;
    if (parts.length === 3) {
        return { section, action, id: null };
    }
    const id = parts[3];
    if (id === undefined || !ENTRY_ID.test(id)) return null;
    return parts.length === 4 ? { section, action, id } : null;
};

// === Responses and payloads ==================================================

/** One rendered ephemeral message, shared by first responses and edits. */
export interface CmsPayload {
    readonly content: string;
    readonly embeds: ReadonlyArray<Discord.RichEmbed>;
    readonly components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
}

/** The document could not be read; the interaction ends without a write. */
const CONTENT_UNAVAILABLE = "Could not read the site content right now — try again in a moment.";

/** Answer for a custom id that does not match this module's grammar. */
const UNKNOWN_ACTION = "That content action is not valid.";

const CANCELLED: CmsPayload = { content: "Cancelled", embeds: [], components: [] };

const ephemeralPayload = (payload: CmsPayload): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        flags: Discord.MessageFlags.Ephemeral,
        allowed_mentions: { parse: [] },
    },
});

const updateMessage = (payload: CmsPayload): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
    data: {
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        allowed_mentions: { parse: [] },
    },
});

const modalResponse = (
    customId: string,
    title: string,
    components: ReadonlyArray<Discord.LabelComponentForModalRequest>,
): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.MODAL,
    data: { custom_id: customId, title, components },
});

const autocompleteResponse = (
    choices: ReadonlyArray<Discord.ApplicationCommandOptionStringChoice>,
): Discord.CreateInteractionResponseRequest => ({
    type: Discord.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
});

const truncate = (value: string, maximum: number): string =>
    value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

// === Modal components ========================================================

/** Short single-line text input; Discord style 1. */
const SHORT = 1;
/** Multi-line text input; Discord style 2. */
const PARAGRAPH = 2;

const textLabel = (
    label: string,
    description: string | null,
    field: string,
    style: 1 | 2,
    maxLength: number,
    value: string,
): Discord.LabelComponentForModalRequest => ({
    type: 18,
    label,
    description,
    component: {
        type: 4,
        custom_id: field,
        style,
        required: true,
        max_length: maxLength,
        value,
    },
});

const selectLabel = (
    label: string,
    description: string | null,
    field: string,
    options: ReadonlyArray<Discord.StringSelectOptionForRequest>,
): Discord.LabelComponentForModalRequest => ({
    type: 18,
    label,
    description,
    component: {
        type: 3,
        custom_id: field,
        required: true,
        min_values: 1,
        max_values: 1,
        options,
    },
});

/** Human-readable names for the icon select; the stored value is the literal. */
const ICON_LABELS = {
    github: "GitHub",
    x: "X / Twitter",
    bluesky: "Bluesky",
    youtube: "YouTube",
    twitch: "Twitch",
    instagram: "Instagram",
    discord: "Discord",
    mail: "Email",
    link: "Generic link",
} satisfies Record<SocialIcon, string>;

const FACT_ICON_LABELS = {
    birthday: "Birthday",
    cats: "Cats",
    music: "Music",
    fitness: "Fitness",
} satisfies Record<FactIcon, string>;

// === Modals ==================================================================

/** `/records`: the three current values, prefilled and replaced as a set. */
export const recordsModal = (records: PersonalRecords): Discord.CreateInteractionResponseRequest =>
    modalResponse(cmsCustomId("records", "edit", null), "Personal records", [
        textLabel("Bench", null, "bench", SHORT, 8, String(records.bench)),
        textLabel("Squat", null, "squat", SHORT, 8, String(records.squat)),
        textLabel("Deadlift", null, "deadlift", SHORT, 8, String(records.deadlift)),
    ]);

const USE_LINES_HINT = "One item per line; add ` — note` after a label for a sub-line.";

/** `/uses`: all three lists as editable text, replaced as a set on submit. */
export const usesModal = (uses: Uses): Discord.CreateInteractionResponseRequest =>
    modalResponse(cmsCustomId("uses", "edit", null), "What I use", [
        textLabel(
            "Software",
            USE_LINES_HINT,
            "software",
            PARAGRAPH,
            4000,
            formatUseLines(uses.software),
        ),
        textLabel(
            "Hardware",
            USE_LINES_HINT,
            "hardware",
            PARAGRAPH,
            4000,
            formatUseLines(uses.hardware),
        ),
        textLabel(
            "Languages",
            USE_LINES_HINT,
            "languages",
            PARAGRAPH,
            4000,
            formatUseLines(uses.languages),
        ),
    ]);

/** The deployed-app modal; `null` opens the add form. */
export const appModal = (app: DeployedApp | null): Discord.CreateInteractionResponseRequest =>
    modalResponse(
        app === null ? cmsCustomId("apps", "add", null) : cmsCustomId("apps", "edit", app.id),
        app === null ? "Add an app" : "Edit an app",
        [
            textLabel("Name", null, "name", SHORT, 60, app?.name ?? ""),
            textLabel("Description", null, "description", PARAGRAPH, 200, app?.description ?? ""),
            textLabel(
                "URL",
                "An https:// link, no port or credentials",
                "url",
                SHORT,
                200,
                app?.url ?? "",
            ),
            textLabel(
                "OG image hosts",
                "Optional public image hostnames, one per line; blank clears approvals",
                "ogImageHosts",
                PARAGRAPH,
                2048,
                app?.ogImageHosts.join("\n") ?? "",
            ),
        ],
    );

/** The open-source project modal; `null` opens the add form. */
export const openSourceModal = (
    project: OpenSourceProject | null,
): Discord.CreateInteractionResponseRequest =>
    modalResponse(
        project === null
            ? cmsCustomId("opensource", "add", null)
            : cmsCustomId("opensource", "edit", project.id),
        project === null ? "Add a project" : "Edit a project",
        [
            textLabel("Name", null, "name", SHORT, 60, project?.name ?? ""),
            textLabel(
                "URL",
                "An https:// link, no port or credentials",
                "url",
                SHORT,
                200,
                project?.url ?? "",
            ),
            textLabel(
                "Description",
                null,
                "description",
                PARAGRAPH,
                120,
                project?.description ?? "",
            ),
        ],
    );

/** The social-link modal; `null` opens the add form. */
export const socialModal = (social: SocialLink | null): Discord.CreateInteractionResponseRequest =>
    modalResponse(
        social === null
            ? cmsCustomId("socials", "add", null)
            : cmsCustomId("socials", "edit", social.id),
        social === null ? "Add a social link" : "Edit a social link",
        [
            textLabel("Label", null, "label", SHORT, 40, social?.label ?? ""),
            textLabel("URL", "An https:// or mailto: link", "url", SHORT, 200, social?.url ?? ""),
            selectLabel(
                "Icon",
                "Shown next to the link on the site",
                "icon",
                SOCIAL_ICONS.map((icon) => ({
                    label: ICON_LABELS[icon],
                    value: icon,
                    default: social !== null && social.icon === icon,
                })),
            ),
        ],
    );

export const experienceModal = (
    entry: WorkExperience | null,
): Discord.CreateInteractionResponseRequest =>
    modalResponse(
        entry === null
            ? cmsCustomId("experience", "add", null)
            : cmsCustomId("experience", "edit", entry.id),
        entry === null ? "Add experience" : "Edit experience",
        [
            textLabel("Company", null, "company", SHORT, 60, entry === null ? "" : entry.company),
            textLabel("Years", null, "years", SHORT, 40, entry === null ? "" : entry.years),
            textLabel("Title", null, "title", SHORT, 80, entry === null ? "" : entry.title),
        ],
    );

export const factsModal = (entry: PersonalFact | null): Discord.CreateInteractionResponseRequest =>
    modalResponse(
        entry === null ? cmsCustomId("facts", "add", null) : cmsCustomId("facts", "edit", entry.id),
        entry === null ? "Add fact" : "Edit fact",
        [
            selectLabel(
                "Icon",
                "Shown next to the fact on the site",
                "icon",
                FACT_ICONS.map((icon) => ({
                    label: FACT_ICON_LABELS[icon],
                    value: icon,
                    default: entry !== null && entry.icon === icon,
                })),
            ),
            textLabel("Label", null, "label", SHORT, 80, entry?.label ?? ""),
        ],
    );

const addModalFor = (section: EntrySection): Discord.CreateInteractionResponseRequest => {
    switch (section) {
        case "apps":
            return appModal(null);
        case "opensource":
            return openSourceModal(null);
        case "socials":
            return socialModal(null);
        case "experience":
            return experienceModal(null);
        case "facts":
            return factsModal(null);
    }
};

/** The prefilled edit modal for one id, or `null` when it is already gone. */
const editModalFor = (
    section: EntrySection,
    content: SiteContent,
    id: string,
): Discord.CreateInteractionResponseRequest | null => {
    switch (section) {
        case "apps": {
            const app = content.apps.find((candidate) => candidate.id === id);
            return app === undefined ? null : appModal(app);
        }
        case "opensource": {
            const project = content.openSource.find((candidate) => candidate.id === id);
            return project === undefined ? null : openSourceModal(project);
        }
        case "socials": {
            const social = content.socials.find((candidate) => candidate.id === id);
            return social === undefined ? null : socialModal(social);
        }
        case "experience": {
            const entry = content.experience.find((candidate) => candidate.id === id);
            return entry === undefined ? null : experienceModal(entry);
        }
        case "facts": {
            const entry = content.facts.find((candidate) => candidate.id === id);
            return entry === undefined ? null : factsModal(entry);
        }
    }
};

// === Pickers and confirmations ===============================================

interface SectionMeta {
    /** The slash command that owns the section. */
    readonly command: string;
    /** How one entry is named in messages. */
    readonly singular: string;
    /** How many entries the section holds at most. */
    readonly capacity: number;
}

const SECTION_META = {
    apps: { command: "apps", singular: "app", capacity: MAX_APPS },
    opensource: { command: "opensource", singular: "project", capacity: MAX_OPEN_SOURCE },
    socials: { command: "socials", singular: "social link", capacity: MAX_SOCIALS },
    experience: { command: "experience", singular: "experience entry", capacity: MAX_EXPERIENCE },
    facts: { command: "facts", singular: "fact", capacity: MAX_FACTS },
} satisfies Record<EntrySection, SectionMeta>;

/** One entry as the pickers and confirmations show it. */
export interface EntrySummary {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
}

const plural = (count: number, noun: string): string =>
    count === 1 ? `1 ${noun}` : `${count} ${noun}s`;

/** Every entry of one section, in document order. */
export const entrySummaries = (
    content: SiteContent,
    section: EntrySection,
): ReadonlyArray<EntrySummary> => {
    switch (section) {
        case "apps":
            return content.apps.map((app) => ({
                id: app.id,
                label: app.name,
                detail: app.url,
            }));
        case "opensource":
            return content.openSource.map((project) => ({
                id: project.id,
                label: project.name,
                detail: project.url,
            }));
        case "socials":
            return content.socials.map((social) => ({
                id: social.id,
                label: social.label,
                detail: `${ICON_LABELS[social.icon]} — ${social.url}`,
            }));
        case "experience":
            return content.experience.map((entry) => ({
                id: entry.id,
                label: entry.company,
                detail: `${entry.years} — ${entry.title}`,
            }));
        case "facts":
            return content.facts.map((entry) => ({
                id: entry.id,
                label: entry.label,
                detail: entry.icon,
            }));
    }
};

const withNotice = (notice: string | null, content: string): string =>
    notice === null ? content : `${notice}\n${content}`;

/**
 * The ephemeral picker for one section, rendered from the current document.
 * An empty section explains which command adds the first entry instead of
 * offering a zero-option select.
 */
export const entryPickerPayload = (
    section: EntrySection,
    action: "pick-edit" | "pick-remove",
    entries: ReadonlyArray<EntrySummary>,
    notice: string | null,
): CmsPayload => {
    const meta = SECTION_META[section];
    const verb = action === "pick-edit" ? "edit" : "remove";
    if (entries.length === 0) {
        return {
            content: withNotice(notice, `Nothing to ${verb} yet — use \`/${meta.command} add\`.`),
            embeds: [],
            components: [],
        };
    }
    const options: Discord.StringSelectOptionForRequest[] = entries
        .slice(0, MAX_PICKER_OPTIONS)
        .map((entry) => ({
            label: truncate(entry.label, MAX_CHOICE_TEXT),
            value: entry.id,
            description: truncate(entry.detail, MAX_CHOICE_TEXT),
        }));
    return {
        content: withNotice(notice, `Pick the ${meta.singular} to ${verb}.`),
        embeds: [],
        components: [
            {
                type: 1,
                components: [
                    UI.select({
                        custom_id: cmsCustomId(section, action, null),
                        options,
                        placeholder: `Choose a ${meta.singular}`,
                    }),
                ],
            },
            UI.row([
                UI.button({
                    custom_id: cmsCustomId(section, "cancel", null),
                    label: "Cancel",
                    style: 2,
                }),
            ]),
        ],
    };
};

/** The explicit removal confirmation for one entry; no storage effect. */
export const removeConfirmationPayload = (
    section: EntrySection,
    entry: EntrySummary,
): CmsPayload => ({
    content: `Remove the ${SECTION_META[section].singular} **${entry.label}**?\n${entry.detail}`,
    embeds: [],
    components: [
        UI.row([
            UI.button({
                custom_id: cmsCustomId(section, "confirm", entry.id),
                label: "Confirm remove",
                style: 4,
            }),
            UI.button({
                custom_id: cmsCustomId(section, "cancel", entry.id),
                label: "Cancel",
                style: 2,
            }),
        ]),
    ],
});

// === Field parsing ===========================================================

const decodeHttpsUrl = Schema.decodeUnknownOption(HttpsUrl);
const decodeLinkUrl = Schema.decodeUnknownOption(LinkUrl);
const decodeRecordValue = Schema.decodeUnknownOption(RecordValue);

/** One trimmed, non-empty, length-checked text field, or the reason it failed. */
const requiredText = (
    fields: Map<string, ModalField>,
    field: string,
    label: string,
    maximum: number,
): Result.Result<string, string> => {
    const raw = textField(fields, field);
    if (raw === null) return Result.fail(`${label} is missing.`);
    const trimmed = raw.trim();
    if (trimmed === "") return Result.fail(`${label} cannot be empty.`);
    if (trimmed.length > maximum) {
        return Result.fail(`${label} must be ${maximum} characters or fewer.`);
    }
    return Result.succeed(trimmed);
};

const requiredHttpsUrl = (
    fields: Map<string, ModalField>,
    field: string,
    label: string,
): Result.Result<string, string> => {
    const text = requiredText(fields, field, label, 200);
    if (Result.isFailure(text)) return text;
    const decoded = decodeHttpsUrl(text.success);
    if (Option.isNone(decoded)) {
        return Result.fail(`${label} must be an https:// link with no port or credentials.`);
    }
    return Result.succeed(decoded.value);
};

const requiredLinkUrl = (
    fields: Map<string, ModalField>,
    field: string,
    label: string,
): Result.Result<string, string> => {
    const text = requiredText(fields, field, label, 200);
    if (Result.isFailure(text)) return text;
    const decoded = decodeLinkUrl(text.success);
    if (Option.isNone(decoded)) {
        return Result.fail(`${label} must be an https:// or mailto: link.`);
    }
    return Result.succeed(decoded.value);
};

const requiredIcon = (fields: Map<string, ModalField>): Result.Result<SocialIcon, string> => {
    const chosen = selectValues(fields, "icon")[0];
    const icon = SOCIAL_ICONS.find((candidate) => candidate === chosen);
    if (icon === undefined) return Result.fail("Pick an icon for the link.");
    return Result.succeed(icon);
};

const requiredFactIcon = (fields: Map<string, ModalField>): Result.Result<FactIcon, string> => {
    const chosen = selectValues(fields, "icon")[0];
    const icon = FACT_ICONS.find((candidate) => candidate === chosen);
    if (icon === undefined) return Result.fail("Pick an icon for the fact.");
    return Result.succeed(icon);
};

const requiredRecord = (
    fields: Map<string, ModalField>,
    field: string,
    label: string,
): Result.Result<number, string> => {
    const raw = textField(fields, field);
    if (raw === null) return Result.fail(`${label} is missing.`);
    const decoded = decodeRecordValue(Number(raw.trim()));
    if (Option.isNone(decoded)) {
        return Result.fail(`${label} must be a number greater than 0 and at most 10000.`);
    }
    return Result.succeed(decoded.value);
};

const requiredUseLines = (
    fields: Map<string, ModalField>,
    field: string,
    label: string,
): Result.Result<ReadonlyArray<UseItem>, string> => {
    const raw = textField(fields, field);
    if (raw === null) return Result.fail(`${label} is missing.`);
    const items = parseUseLines(raw);
    if (items === null) {
        return Result.fail(
            `${label} needs 1 to ${MAX_USE_ITEMS} lines, each label and note 60 characters or fewer.`,
        );
    }
    return Result.succeed(items);
};

/** The validated app fields of one modal submission. */
interface AppFields {
    readonly name: string;
    readonly description: string;
    readonly url: string;
    readonly ogImageHosts: ReadonlyArray<string>;
}

/** The validated open-source fields of one modal submission. */
interface ProjectFields {
    readonly name: string;
    readonly url: string;
    readonly description: string;
}

/** The validated social-link fields of one modal submission. */
interface SocialFields {
    readonly label: string;
    readonly url: string;
    readonly icon: SocialIcon;
}

interface ExperienceFields {
    readonly company: string;
    readonly years: string;
    readonly title: string;
}

interface FactFields {
    readonly icon: FactIcon;
    readonly label: string;
}

const parseAppFields = (fields: Map<string, ModalField>): Result.Result<AppFields, string> => {
    const name = requiredText(fields, "name", "Name", 60);
    if (Result.isFailure(name)) return Result.fail(name.failure);
    const description = requiredText(fields, "description", "Description", 200);
    if (Result.isFailure(description)) return Result.fail(description.failure);
    const url = requiredHttpsUrl(fields, "url", "URL");
    if (Result.isFailure(url)) return Result.fail(url.failure);
    const rawHosts = textField(fields, "ogImageHosts") ?? "";
    const ogImageHosts = parseOgImageHosts(rawHosts);
    if (ogImageHosts === null) {
        return Result.fail("OG image hosts must be public DNS hostnames, one per line.");
    }
    return Result.succeed({
        name: name.success,
        description: description.success,
        url: url.success,
        ogImageHosts,
    });
};

const parseExperienceFields = (
    fields: Map<string, ModalField>,
): Result.Result<ExperienceFields, string> => {
    const company = requiredText(fields, "company", "Company", 60);
    if (Result.isFailure(company)) return Result.fail(company.failure);
    const years = requiredText(fields, "years", "Years", 40);
    if (Result.isFailure(years)) return Result.fail(years.failure);
    const title = requiredText(fields, "title", "Title", 80);
    if (Result.isFailure(title)) return Result.fail(title.failure);
    return Result.succeed({ company: company.success, years: years.success, title: title.success });
};

const parseFactFields = (fields: Map<string, ModalField>): Result.Result<FactFields, string> => {
    const icon = requiredFactIcon(fields);
    if (Result.isFailure(icon)) return Result.fail(icon.failure);
    const label = requiredText(fields, "label", "Label", 80);
    if (Result.isFailure(label)) return Result.fail(label.failure);
    return Result.succeed({ icon: icon.success, label: label.success });
};

const parseProjectFields = (
    fields: Map<string, ModalField>,
): Result.Result<ProjectFields, string> => {
    const name = requiredText(fields, "name", "Name", 60);
    if (Result.isFailure(name)) return Result.fail(name.failure);
    const url = requiredHttpsUrl(fields, "url", "URL");
    if (Result.isFailure(url)) return Result.fail(url.failure);
    const description = requiredText(fields, "description", "Description", 120);
    if (Result.isFailure(description)) return Result.fail(description.failure);
    return Result.succeed({
        name: name.success,
        url: url.success,
        description: description.success,
    });
};

const parseSocialFields = (
    fields: Map<string, ModalField>,
): Result.Result<SocialFields, string> => {
    const label = requiredText(fields, "label", "Label", 40);
    if (Result.isFailure(label)) return Result.fail(label.failure);
    const url = requiredLinkUrl(fields, "url", "URL");
    if (Result.isFailure(url)) return Result.fail(url.failure);
    const icon = requiredIcon(fields);
    if (Result.isFailure(icon)) return Result.fail(icon.failure);
    return Result.succeed({ label: label.success, url: url.success, icon: icon.success });
};

// === Document changes ========================================================

/**
 * Every mutation is one of these: a pure function of the document the writer
 * just handed back, so a concurrent change can never be overwritten by a
 * document computed from an older read.
 */
type ContentChange = (current: SiteContent) => Result.Result<SiteContent, ContentValidationError>;

const refuse = (message: string): Result.Result<SiteContent, ContentValidationError> =>
    Result.fail(new ContentValidationError({ message }));

const fullSection = (section: EntrySection): string =>
    `That list already holds ${SECTION_META[section].capacity} entries — remove one first.`;

const addApp =
    (id: string, input: AppFields): ContentChange =>
    (current) => {
        if (current.apps.length >= MAX_APPS) return refuse(fullSection("apps"));
        if (current.apps.some((app) => app.id === id)) {
            return refuse("An app with that id already exists.");
        }
        return Result.succeed({
            ...current,
            apps: [...current.apps, { id, ...input }],
        });
    };

const editApp =
    (id: string, input: AppFields): ContentChange =>
    (current) => {
        const index = current.apps.findIndex((app) => app.id === id);
        const app = current.apps[index];
        if (app === undefined) return refuse(MISSING_ENTRY_MESSAGE);
        const apps = [...current.apps];
        apps[index] = { ...app, ...input };
        return Result.succeed({ ...current, apps });
    };

const addProject =
    (id: string, input: ProjectFields): ContentChange =>
    (current) => {
        if (current.openSource.length >= MAX_OPEN_SOURCE) return refuse(fullSection("opensource"));
        if (current.openSource.some((project) => project.id === id)) {
            return refuse("A project with that id already exists.");
        }
        return Result.succeed({
            ...current,
            openSource: [...current.openSource, { id, ...input }],
        });
    };

const editProject =
    (id: string, input: ProjectFields): ContentChange =>
    (current) => {
        const index = current.openSource.findIndex((project) => project.id === id);
        const project = current.openSource[index];
        if (project === undefined) return refuse(MISSING_ENTRY_MESSAGE);
        const openSource = [...current.openSource];
        openSource[index] = { ...project, ...input };
        return Result.succeed({ ...current, openSource });
    };

const addSocial =
    (id: string, input: SocialFields): ContentChange =>
    (current) => {
        if (current.socials.length >= MAX_SOCIALS) return refuse(fullSection("socials"));
        if (current.socials.some((social) => social.id === id)) {
            return refuse("A social link with that id already exists.");
        }
        return Result.succeed({ ...current, socials: [...current.socials, { id, ...input }] });
    };

const editSocial =
    (id: string, input: SocialFields): ContentChange =>
    (current) => {
        const index = current.socials.findIndex((social) => social.id === id);
        const social = current.socials[index];
        if (social === undefined) return refuse(MISSING_ENTRY_MESSAGE);
        const socials = [...current.socials];
        socials[index] = { ...social, ...input };
        return Result.succeed({ ...current, socials });
    };

const addExperience =
    (id: string, input: ExperienceFields): ContentChange =>
    (current) => {
        if (current.experience.length >= SECTION_META.experience.capacity)
            return refuse(fullSection("experience"));
        if (current.experience.some((entry) => entry.id === id))
            return refuse("An experience entry with that id already exists.");
        return Result.succeed({
            ...current,
            experience: [...current.experience, { id, ...input }],
        });
    };

const editExperience =
    (id: string, input: ExperienceFields): ContentChange =>
    (current) => {
        const index = current.experience.findIndex((entry) => entry.id === id);
        const entry = current.experience[index];
        if (entry === undefined) return refuse(MISSING_ENTRY_MESSAGE);
        const experience = [...current.experience];
        experience[index] = { ...entry, ...input };
        return Result.succeed({ ...current, experience });
    };

const addFact =
    (id: string, input: FactFields): ContentChange =>
    (current) => {
        if (current.facts.length >= SECTION_META.facts.capacity)
            return refuse(fullSection("facts"));
        if (current.facts.some((fact) => fact.id === id))
            return refuse("A fact with that id already exists.");
        return Result.succeed({ ...current, facts: [...current.facts, { id, ...input }] });
    };

const editFact =
    (id: string, input: FactFields): ContentChange =>
    (current) => {
        const index = current.facts.findIndex((fact) => fact.id === id);
        const fact = current.facts[index];
        if (fact === undefined) return refuse(MISSING_ENTRY_MESSAGE);
        const facts = [...current.facts];
        facts[index] = { ...fact, ...input };
        return Result.succeed({ ...current, facts });
    };

const removeEntry =
    (section: EntrySection, id: string): ContentChange =>
    (current) => {
        switch (section) {
            case "apps": {
                if (!current.apps.some((app) => app.id === id))
                    return refuse(MISSING_ENTRY_MESSAGE);
                return Result.succeed({
                    ...current,
                    apps: current.apps.filter((app) => app.id !== id),
                });
            }
            case "opensource": {
                if (!current.openSource.some((project) => project.id === id)) {
                    return refuse(MISSING_ENTRY_MESSAGE);
                }
                return Result.succeed({
                    ...current,
                    openSource: current.openSource.filter((project) => project.id !== id),
                });
            }
            case "socials": {
                if (!current.socials.some((social) => social.id === id)) {
                    return refuse(MISSING_ENTRY_MESSAGE);
                }
                return Result.succeed({
                    ...current,
                    socials: current.socials.filter((social) => social.id !== id),
                });
            }
            case "experience": {
                if (!current.experience.some((entry) => entry.id === id))
                    return refuse(MISSING_ENTRY_MESSAGE);
                return Result.succeed({
                    ...current,
                    experience: current.experience.filter((entry) => entry.id !== id),
                });
            }
            case "facts": {
                if (!current.facts.some((fact) => fact.id === id))
                    return refuse(MISSING_ENTRY_MESSAGE);
                return Result.succeed({
                    ...current,
                    facts: current.facts.filter((fact) => fact.id !== id),
                });
            }
        }
    };

// === Job plumbing ============================================================

interface Reporter {
    readonly rest: DiscordRestService;
    readonly clientId: string;
}

/**
 * Report one job outcome by replacing the original response's message: the
 * report always stands alone, so the picker's embeds and controls go away.
 */
const reportText = (reporter: Reporter, interaction: Discord.APIInteraction, content: string) =>
    reporter.rest.updateOriginalWebhookMessage(reporter.clientId, interaction.token, {
        payload: {
            content,
            embeds: [],
            components: [],
            allowed_mentions: { parse: [] },
        },
    });

/**
 * Log one refused storage operation. A validation message is already
 * user-facing; a storage error contributes only its operation, reason tag and
 * upstream status — never a request object or a provider message.
 */
const logStorageFailure = (operation: string, error: BotStorageError | ContentValidationError) =>
    Effect.logWarning(
        `CMS: ${operation} refused (${
            error._tag === "Discord.ContentValidationError"
                ? error.message
                : `${error.operation}/${error.reason}/${error.status ?? "no-status"}`
        })`,
    );

/**
 * Apply one change and report it. A refused change (the entry vanished, a cap
 * is full, the edited document does not validate) reports its user-facing
 * message; an unclear storage failure propagates so {@link asJob} reports it
 * without claiming anything about the document.
 */
const applyChange = (
    storage: BotContentClientService,
    reporter: Reporter,
    interaction: Discord.APIInteraction,
    change: ContentChange,
    success: string,
) =>
    Effect.gen(function* () {
        const applied = yield* Effect.result(storage.updateContent(change));
        if (Result.isFailure(applied)) {
            if (applied.failure._tag === "Discord.ContentValidationError") {
                yield* logStorageFailure("updateContent", applied.failure);
                yield* reportText(reporter, interaction, applied.failure.message);
                return;
            }
            return yield* applied.failure;
        }
        yield* reportText(reporter, interaction, success);
    });

/** Both owner checks against an interaction the caller already holds. */
const isOwnerInteraction = (
    interaction: Discord.APIInteraction,
    config: BotConfigService,
): boolean =>
    interaction.guild_id === config.serverId &&
    (interaction.member?.user.id ?? interaction.user?.id) === config.userId;

/** The current document, or the ephemeral answer explaining it is unreadable. */
const readContentOrAnswer = (storage: BotContentClientService) =>
    Effect.gen(function* () {
        const content = yield* Effect.result(storage.loadContent);
        if (Result.isFailure(content)) {
            yield* logStorageFailure("loadContent", content.failure);
            return null;
        }
        return content.success;
    });

// === Slash-command flows =====================================================

/** `/records`: open the records modal prefilled with the stored values. */
export const recordsFlow = Effect.fn("Cms.recordsFlow")(function* (
    interaction: Discord.APIInteraction,
) {
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const storage = yield* BotContentClient;
    const content = yield* readContentOrAnswer(storage);
    if (content === null) return ephemeralResponse(CONTENT_UNAVAILABLE);
    return recordsModal(content.records);
});

/** `/uses`: open the three-list modal prefilled with `formatUseLines`. */
export const usesFlow = Effect.fn("Cms.usesFlow")(function* (interaction: Discord.APIInteraction) {
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const storage = yield* BotContentClient;
    const content = yield* readContentOrAnswer(storage);
    if (content === null) return ephemeralResponse(CONTENT_UNAVAILABLE);
    return usesModal(content.uses);
});

/**
 * `/apps|/opensource|/socials add|edit|remove`: the add modal, or the
 * ephemeral picker rendered from the current document.
 */
export const cmsEntryFlow = Effect.fn("Cms.entryFlow")(function* (
    interaction: Discord.APIInteraction,
    section: EntrySection,
    action: "add" | "edit" | "remove",
) {
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    if (action === "add") return addModalFor(section);
    const storage = yield* BotContentClient;
    const content = yield* readContentOrAnswer(storage);
    if (content === null) return ephemeralResponse(CONTENT_UNAVAILABLE);
    const pick = action === "edit" ? "pick-edit" : "pick-remove";
    return ephemeralPayload(
        entryPickerPayload(section, pick, entrySummaries(content, section), null),
    );
});

// === Component interactions ==================================================

const entryComponent = (
    section: EntrySection,
    parsed: ParsedCmsCustomId,
    chosen: string | null,
    interaction: Discord.APIInteraction,
    storage: BotContentClientService,
    reporter: Reporter,
) =>
    Effect.gen(function* () {
        switch (parsed.action) {
            case "pick-edit":
            case "pick-remove": {
                const content = yield* readContentOrAnswer(storage);
                if (content === null) return ephemeralResponse(CONTENT_UNAVAILABLE);
                const entries = entrySummaries(content, section);
                const entry =
                    chosen === null
                        ? undefined
                        : entries.find((candidate) => candidate.id === chosen);
                if (entry === undefined) {
                    return updateMessage(
                        entryPickerPayload(section, parsed.action, entries, MISSING_ENTRY_MESSAGE),
                    );
                }
                if (parsed.action === "pick-remove") {
                    return updateMessage(removeConfirmationPayload(section, entry));
                }
                const modal = editModalFor(section, content, entry.id);
                if (modal === null) {
                    return updateMessage(
                        entryPickerPayload(section, "pick-edit", entries, MISSING_ENTRY_MESSAGE),
                    );
                }
                return modal;
            }
            case "confirm": {
                const id = parsed.id;
                if (id === null) return ephemeralResponse(UNKNOWN_ACTION);
                yield* queueJob(
                    asJob(
                        reporter,
                        interaction,
                        Effect.gen(function* () {
                            const content = yield* storage.loadContent;
                            const entry = entrySummaries(content, section).find(
                                (candidate) => candidate.id === id,
                            );
                            if (entry === undefined) {
                                yield* reportText(reporter, interaction, MISSING_ENTRY_MESSAGE);
                                return;
                            }
                            yield* applyChange(
                                storage,
                                reporter,
                                interaction,
                                removeEntry(section, id),
                                `Removed **${entry.label}**.`,
                            );
                        }),
                    ),
                );
                return deferredComponentAck;
            }
            default:
                return ephemeralResponse(UNKNOWN_ACTION);
        }
    });

/**
 * Every `cms:` component click: re-authorize, re-validate the whole custom id,
 * and act on the current document — never on what the message displayed.
 */
export const handleCmsComponent = Effect.gen(function* () {
    const interaction = yield* Interaction;
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const data = yield* MessageComponentData;
    const parsed = parseCmsCustomId(data.custom_id);
    if (parsed === null) return ephemeralResponse(UNKNOWN_ACTION);
    if (parsed.action === "cancel") return updateMessage(CANCELLED);

    const storage = yield* BotContentClient;
    const rest = yield* DiscordREST;
    const reporter: Reporter = { rest, clientId: config.clientId };
    // Buttons carry no values; a select always carries exactly one here.
    const chosen = "values" in data ? (data.values[0] ?? null) : null;

    switch (parsed.section) {
        case "apps":
        case "opensource":
        case "experience":
        case "facts":
        case "socials":
            return yield* entryComponent(
                parsed.section,
                parsed,
                chosen,
                interaction,
                storage,
                reporter,
            );
        default:
            // `records` and `uses` are modal-only sections.
            return ephemeralResponse(UNKNOWN_ACTION);
    }
});

// === Modal submissions =======================================================

const recordsSubmission = (
    fields: Map<string, ModalField>,
    interaction: Discord.APIInteraction,
    storage: BotContentClientService,
    reporter: Reporter,
) =>
    Effect.gen(function* () {
        const bench = requiredRecord(fields, "bench", "Bench");
        if (Result.isFailure(bench)) return ephemeralResponse(bench.failure);
        const squat = requiredRecord(fields, "squat", "Squat");
        if (Result.isFailure(squat)) return ephemeralResponse(squat.failure);
        const deadlift = requiredRecord(fields, "deadlift", "Deadlift");
        if (Result.isFailure(deadlift)) return ephemeralResponse(deadlift.failure);
        const records: PersonalRecords = {
            bench: bench.success,
            squat: squat.success,
            deadlift: deadlift.success,
        };
        yield* queueJob(
            asJob(
                reporter,
                interaction,
                applyChange(
                    storage,
                    reporter,
                    interaction,
                    (current) => Result.succeed({ ...current, records }),
                    `Saved records — bench ${records.bench}, squat ${records.squat}, deadlift ${records.deadlift}.`,
                ),
            ),
        );
        return deferredEphemeralAck;
    });

const usesSubmission = (
    fields: Map<string, ModalField>,
    interaction: Discord.APIInteraction,
    storage: BotContentClientService,
    reporter: Reporter,
) =>
    Effect.gen(function* () {
        const software = requiredUseLines(fields, "software", "Software");
        if (Result.isFailure(software)) return ephemeralResponse(software.failure);
        const hardware = requiredUseLines(fields, "hardware", "Hardware");
        if (Result.isFailure(hardware)) return ephemeralResponse(hardware.failure);
        const languages = requiredUseLines(fields, "languages", "Languages");
        if (Result.isFailure(languages)) return ephemeralResponse(languages.failure);
        const uses: Uses = {
            software: software.success,
            hardware: hardware.success,
            languages: languages.success,
        };
        yield* queueJob(
            asJob(
                reporter,
                interaction,
                applyChange(
                    storage,
                    reporter,
                    interaction,
                    (current) => Result.succeed({ ...current, uses }),
                    `Saved what I use — ${plural(uses.software.length, "software item")}, ${plural(
                        uses.hardware.length,
                        "hardware item",
                    )}, ${plural(uses.languages.length, "language")}.`,
                ),
            ),
        );
        return deferredEphemeralAck;
    });

/** The change and report for one add/edit submission, or the reason it failed. */
const entryChange = (
    section: EntrySection,
    action: "add" | "edit",
    id: string,
    fields: Map<string, ModalField>,
): Result.Result<{ readonly change: ContentChange; readonly success: string }, string> => {
    switch (section) {
        case "apps": {
            const input = parseAppFields(fields);
            if (Result.isFailure(input)) return Result.fail(input.failure);
            return Result.succeed(
                action === "add"
                    ? {
                          change: addApp(id, input.success),
                          success: `Added the app **${input.success.name}**.`,
                      }
                    : {
                          change: editApp(id, input.success),
                          success: `Updated the app **${input.success.name}**.`,
                      },
            );
        }
        case "opensource": {
            const input = parseProjectFields(fields);
            if (Result.isFailure(input)) return Result.fail(input.failure);
            return Result.succeed(
                action === "add"
                    ? {
                          change: addProject(id, input.success),
                          success: `Added the project **${input.success.name}**.`,
                      }
                    : {
                          change: editProject(id, input.success),
                          success: `Updated the project **${input.success.name}**.`,
                      },
            );
        }
        case "socials": {
            const input = parseSocialFields(fields);
            if (Result.isFailure(input)) return Result.fail(input.failure);
            return Result.succeed(
                action === "add"
                    ? {
                          change: addSocial(id, input.success),
                          success: `Added the social link **${input.success.label}**.`,
                      }
                    : {
                          change: editSocial(id, input.success),
                          success: `Updated the social link **${input.success.label}**.`,
                      },
            );
        }
        case "experience": {
            const input = parseExperienceFields(fields);
            if (Result.isFailure(input)) return Result.fail(input.failure);
            return Result.succeed(
                action === "add"
                    ? {
                          change: addExperience(id, input.success),
                          success: `Added experience at **${input.success.company}**.`,
                      }
                    : {
                          change: editExperience(id, input.success),
                          success: `Updated experience at **${input.success.company}**.`,
                      },
            );
        }
        case "facts": {
            const input = parseFactFields(fields);
            if (Result.isFailure(input)) return Result.fail(input.failure);
            return Result.succeed(
                action === "add"
                    ? {
                          change: addFact(id, input.success),
                          success: `Added the fact **${input.success.label}**.`,
                      }
                    : {
                          change: editFact(id, input.success),
                          success: `Updated the fact **${input.success.label}**.`,
                      },
            );
        }
    }
};

/**
 * Every `cms:` modal submit: re-authorize, validate the fields with no storage
 * access, then ACK and queue the write. Invalid input never reaches storage.
 */
export const handleCmsModal = Effect.gen(function* () {
    const interaction = yield* Interaction;
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const data = yield* ModalSubmitData;
    const parsed = parseCmsCustomId(data.custom_id);
    if (parsed === null) return ephemeralResponse(UNKNOWN_ACTION);

    const fields = modalFields(data);

    switch (parsed.section) {
        case "records": {
            if (parsed.action !== "edit" || parsed.id !== null) {
                return ephemeralResponse(UNKNOWN_ACTION);
            }
            const storage = yield* BotContentClient;
            const rest = yield* DiscordREST;
            const reporter: Reporter = { rest, clientId: config.clientId };
            return yield* recordsSubmission(fields, interaction, storage, reporter);
        }
        case "uses": {
            if (parsed.action !== "edit" || parsed.id !== null) {
                return ephemeralResponse(UNKNOWN_ACTION);
            }
            const storage = yield* BotContentClient;
            const rest = yield* DiscordREST;
            const reporter: Reporter = { rest, clientId: config.clientId };
            return yield* usesSubmission(fields, interaction, storage, reporter);
        }
        case "apps":
        case "opensource":
        case "experience":
        case "facts":
        case "socials": {
            const section = parsed.section;
            if (parsed.action === "add") {
                if (parsed.id !== null) return ephemeralResponse(UNKNOWN_ACTION);
                // A new entry is identified by the interaction that created it.
                if (!ENTRY_ID.test(interaction.id)) {
                    return ephemeralResponse("That interaction cannot be used as an entry id.");
                }
            } else if (parsed.action !== "edit" || parsed.id === null) {
                return ephemeralResponse(UNKNOWN_ACTION);
            }
            const action = parsed.action === "add" ? "add" : "edit";
            const id = parsed.id ?? interaction.id;
            const planned = entryChange(section, action, id, fields);
            if (Result.isFailure(planned)) return ephemeralResponse(planned.failure);
            const storage = yield* BotContentClient;
            const rest = yield* DiscordREST;
            const reporter: Reporter = { rest, clientId: config.clientId };
            yield* queueJob(
                asJob(
                    reporter,
                    interaction,
                    applyChange(
                        storage,
                        reporter,
                        interaction,
                        planned.success.change,
                        planned.success.success,
                    ),
                ),
            );
            return deferredEphemeralAck;
        }
        default:
            return ephemeralResponse(UNKNOWN_ACTION);
    }
});

// === Autocomplete ============================================================

/**
 * `app` autocomplete for every `/apps` subcommand: owner-only, read-only, and
 * answered directly because it never writes. A non-owner and an unreadable
 * document both get an empty choice list, never an error message.
 */
export const handleAppAutocomplete = Effect.gen(function* () {
    const interaction = yield* Interaction;
    const config = yield* BotConfig;
    if (!isOwnerInteraction(interaction, config)) return autocompleteResponse([]);
    const focused = yield* focusedOptionValue;
    const storage = yield* BotContentClient;
    const content = yield* readContentOrAnswer(storage);
    if (content === null) return autocompleteResponse([]);
    const query = String(focused).trim().toLowerCase();
    const choices: Discord.ApplicationCommandOptionStringChoice[] = [];
    for (const app of content.apps) {
        if (choices.length >= MAX_PICKER_OPTIONS) break;
        const matches =
            query === "" ||
            app.name.toLowerCase().includes(query) ||
            app.id.toLowerCase().includes(query);
        if (matches) {
            choices.push({ name: truncate(app.name, MAX_CHOICE_TEXT), value: app.id });
        }
    }
    return autocompleteResponse(choices);
});
