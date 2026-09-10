/**
 * The site-content contract: one JSON document (key `site-content`) that the
 * bot edits through Discord modals and the website reads through the presence
 * Worker. This module is browser-safe — schemas, defaults, pure validation,
 * and the KV read helper only; no credentials.
 *
 * Every interface is the same-name twin of its schema, following `schema.ts`,
 * so encoded and decoded shapes stay identical and a document can travel as
 * plain JSON. Documents are validated whole: a stored document that fails any
 * field is corrupt and must fail the read, never degrade into defaults.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CONTENT_KEY } from "./config.ts";
import { isPublicDnsHostname } from "./project-hosts.ts";
import { kvDocumentStore } from "./store.ts";
import type { PresenceKvBinding } from "./store.ts";

/** Cap for editable list sections; matches Discord's select-menu option limit. */
export const MAX_APPS = 25;
export const MAX_OPEN_SOURCE = 25;
export const MAX_SOCIALS = 25;
export const MAX_EXPERIENCE = 25;
export const MAX_FACTS = 25;
/** Cap for "What I use" entries — also the modal text-line budget. */
export const MAX_USE_ITEMS = 25;
/**
 * Cap for approved visitor notes. A separate payload budget, not a
 * select-menu constraint: at capacity the submission stays pending, and a
 * published note is never silently evicted.
 */
export const MAX_NOTES = 100;
/** Visitor note body limit, shared by the composer, Worker and bot. */
export const MAX_NOTE_BODY = 120;

/**
 * Identifier for one editable entry. Bot-created entries use the creating
 * modal-submit interaction id (digits satisfy the pattern); seeded entries use
 * readable ids.
 */
export const EntryId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,32}$/u));

export type EntryId = Schema.Schema.Type<typeof EntryId>;

const MAX_URL_LENGTH = 200;

function parsesAsHttps(value: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.port === ""
    );
}

function parsesAsMailto(value: string): boolean {
    if (!value.startsWith("mailto:")) return false;
    const address = value.slice("mailto:".length);
    return address !== "" && !/\s/u.test(address);
}

/**
 * A fully normalized URL: trimmed, at most 200 characters, `https:`, no
 * embedded credentials and no port. The trim is part of the contract — callers
 * that accept free text trim first, and a stored value with padding is corrupt.
 */
export const HttpsUrl = Schema.String.check(
    Schema.isMaxLength(MAX_URL_LENGTH),
    Schema.makeFilter<string>(
        (value) => (value === value.trim() && parsesAsHttps(value) ? undefined : false),
        { identifier: "Presence.HttpsUrl" },
    ),
);

export type HttpsUrl = Schema.Schema.Type<typeof HttpsUrl>;

/** {@link HttpsUrl} plus `mailto:` with a non-empty address — social links only. */
export const LinkUrl = Schema.String.check(
    Schema.isMaxLength(MAX_URL_LENGTH),
    Schema.makeFilter<string>(
        (value) =>
            value === value.trim() && (parsesAsHttps(value) || parsesAsMailto(value))
                ? undefined
                : false,
        { identifier: "Presence.LinkUrl" },
    ),
);

export type LinkUrl = Schema.Schema.Type<typeof LinkUrl>;

/** One powerlifting record: a unitless finite number in (0, 10000]. */
export const RecordValue = Schema.Finite.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(10000),
);

export type RecordValue = Schema.Schema.Type<typeof RecordValue>;

export const PersonalRecords = Schema.Struct({
    bench: RecordValue,
    squat: RecordValue,
    deadlift: RecordValue,
});

export type PersonalRecords = typeof PersonalRecords.Type;

function boundedLabel(maximum: number) {
    return Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
}

/** Legacy screenshot records are private to the storage migration boundary. */
const LegacyManagedShotKey = Schema.String.check(
    Schema.isPattern(/^apps\/[a-z0-9-]{1,32}\/[0-9]{17,20}\.webp$/u),
);

const LegacyScreenshot = Schema.Struct({
    key: Schema.NullOr(LegacyManagedShotKey),
    url: HttpsUrl,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    alt: boundedLabel(120),
});

export const DeployedApp = Schema.Struct({
    id: EntryId,
    name: boundedLabel(60),
    description: boundedLabel(200),
    url: HttpsUrl,
    ogImageHosts: Schema.Array(
        Schema.String.check(
            Schema.makeFilter<string>((value) => (isPublicDnsHostname(value) ? undefined : false), {
                identifier: "Presence.OgImageHost",
            }),
        ),
    ).check(
        Schema.isMaxLength(8),
        Schema.makeFilter<ReadonlyArray<string>>(
            (hosts) => (new Set(hosts).size === hosts.length ? undefined : false),
            { identifier: "Presence.UniqueOgImageHosts" },
        ),
    ),
});

export type DeployedApp = typeof DeployedApp.Type;

export const WorkExperience = Schema.Struct({
    id: EntryId,
    company: boundedLabel(60),
    years: boundedLabel(40),
    title: boundedLabel(80),
});

export type WorkExperience = typeof WorkExperience.Type;

export const FactIcon = Schema.Literals(["birthday", "cats", "music", "fitness"]);

export type FactIcon = typeof FactIcon.Type;

/** Every icon literal offered by the personal-facts picker. */
export const FACT_ICONS: readonly FactIcon[] = ["birthday", "cats", "music", "fitness"];

export const PersonalFact = Schema.Struct({
    id: EntryId,
    icon: FactIcon,
    label: boundedLabel(80),
});

export type PersonalFact = typeof PersonalFact.Type;

export const OpenSourceProject = Schema.Struct({
    id: EntryId,
    name: boundedLabel(60),
    url: HttpsUrl,
    description: boundedLabel(120),
});

export type OpenSourceProject = typeof OpenSourceProject.Type;

/**
 * Icon identifiers. A retired brand (an icon removed from the icon pack on a
 * future upgrade) maps to the lucide `Link` glyph at render time — it is never
 * a reason to reject a stored document.
 */
export const SocialIcon = Schema.Literals([
    "github",
    "x",
    "bluesky",
    "youtube",
    "twitch",
    "instagram",
    "discord",
    "mail",
    "link",
]);

export type SocialIcon = typeof SocialIcon.Type;

/** Every icon literal, for pickers that must offer the full set. */
export const SOCIAL_ICONS: readonly SocialIcon[] = [
    "github",
    "x",
    "bluesky",
    "youtube",
    "twitch",
    "instagram",
    "discord",
    "mail",
    "link",
];

export const SocialLink = Schema.Struct({
    id: EntryId,
    label: boundedLabel(40),
    url: LinkUrl,
    icon: SocialIcon,
});

export type SocialLink = typeof SocialLink.Type;

export const UseItem = Schema.Struct({
    label: boundedLabel(60),
});

export type UseItem = typeof UseItem.Type;

export const Uses = Schema.Struct({
    software: Schema.Array(UseItem).check(Schema.isMaxLength(MAX_USE_ITEMS)),
    hardware: Schema.Array(UseItem).check(Schema.isMaxLength(MAX_USE_ITEMS)),
    languages: Schema.Array(UseItem).check(Schema.isMaxLength(MAX_USE_ITEMS)),
});

export type Uses = typeof Uses.Type;

/** Canonical ISO timestamp: exactly what `new Date(...).toISOString()` emits. */
export const IsoTimestamp = Schema.String.check(
    Schema.makeFilter<string>(
        (value) => {
            return Option.exists(
                DateTime.make(value),
                (instant) => DateTime.formatIso(instant) === value,
            )
                ? undefined
                : false;
        },
        { identifier: "Presence.IsoTimestamp" },
    ),
);

export type IsoTimestamp = Schema.Schema.Type<typeof IsoTimestamp>;

/** Trim free text; blank input becomes `null` (an anonymous note). */
export function normalizeNoteText(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

/** Same normalization as {@link normalizeNoteText}; a distinct name for clarity. */
export function normalizeNoteName(value: string): string | null {
    return normalizeNoteText(value);
}

/** A trimmed, non-empty note name, or `null` for an anonymous note. */
export const NoteName = Schema.NullOr(boundedLabel(40));

export type NoteName = Schema.Schema.Type<typeof NoteName>;

/** A trimmed, non-empty note body of at most MAX_NOTE_BODY characters. */
export const NoteBody = boundedLabel(MAX_NOTE_BODY);

/** One approved visitor note. Submitted and approved times are server-owned;
 * the body is plain text with no HTML, attachments or Markdown rendering.
 */
export const VisitorNote = Schema.Struct({
    id: EntryId,
    name: NoteName,
    body: NoteBody,
    submittedAt: IsoTimestamp,
    approvedAt: IsoTimestamp,
});

export type VisitorNote = typeof VisitorNote.Type;

/** Fails an entry array when two items share an id. */
const uniqueEntryIds = Schema.makeFilter<ReadonlyArray<{ readonly id: string }>>(
    (items) => (new Set(items.map((item) => item.id)).size === items.length ? undefined : false),
    { identifier: "Presence.UniqueEntryIds" },
);

const Notes = Schema.Array(VisitorNote).check(Schema.isMaxLength(MAX_NOTES), uniqueEntryIds);

const Experience = Schema.Array(WorkExperience).check(
    Schema.isMaxLength(MAX_EXPERIENCE),
    uniqueEntryIds,
);

const Facts = Schema.Array(PersonalFact).check(Schema.isMaxLength(MAX_FACTS), uniqueEntryIds);

const SiteContentFields = {
    records: PersonalRecords,
    apps: Schema.Array(DeployedApp).check(Schema.isMaxLength(MAX_APPS), uniqueEntryIds),
    openSource: Schema.Array(OpenSourceProject).check(
        Schema.isMaxLength(MAX_OPEN_SOURCE),
        uniqueEntryIds,
    ),
    socials: Schema.Array(SocialLink).check(Schema.isMaxLength(MAX_SOCIALS), uniqueEntryIds),
    uses: Uses,
    notes: Notes,
    experience: Experience,
    facts: Facts,
    updatedAt: Schema.NullOr(IsoTimestamp),
};

/**
 * The canonical site-content contract. Every field is required: callers must
 * never receive defaults merely because an API payload omitted a field.
 */
export const SiteContent = Schema.Struct(SiteContentFields);

export type SiteContent = typeof SiteContent.Type;

/**
 * Legacy app shape used only while reading persisted documents. Screenshots
 * are decoded and validated before being dropped; they are not a public
 * compatibility field.
 */
const LegacyDeployedApp = Schema.Struct({
    id: EntryId,
    name: boundedLabel(60),
    description: boundedLabel(200),
    url: HttpsUrl,
    screenshots: Schema.optionalKey(Schema.Array(LegacyScreenshot).check(Schema.isMaxLength(10))),
    ogImageHosts: Schema.optionalKey(DeployedApp.fields.ogImageHosts),
});

const LegacyContentDocument = Schema.Struct({
    records: PersonalRecords,
    apps: Schema.Array(LegacyDeployedApp).check(Schema.isMaxLength(MAX_APPS), uniqueEntryIds),
    openSource: Schema.Array(OpenSourceProject).check(
        Schema.isMaxLength(MAX_OPEN_SOURCE),
        uniqueEntryIds,
    ),
    socials: Schema.Array(SocialLink).check(Schema.isMaxLength(MAX_SOCIALS), uniqueEntryIds),
    uses: Uses,
    notes: Schema.optionalKey(Notes),
    experience: Schema.optionalKey(Experience),
    facts: Schema.optionalKey(Facts),
    updatedAt: Schema.NullOr(IsoTimestamp),
});

const decodeLegacyContent = Schema.decodeUnknownEffect(
    Schema.fromJsonString(LegacyContentDocument),
);

const BLOCKY_URL = "https://www.blocky.so";
const BLOCKY_OG_IMAGE_HOSTS = ["assets.blocky.so", "www.blocky.so", "blocky.so"] as const;

/**
 * Decode a persisted content document, applying only the migrations for fields
 * that did not exist in the old storage shape. Present fields are always
 * validated and never repaired.
 */
export const decodeContentDocument = Effect.fn("Presence.decodeContentDocument")(function* (
    document: string,
) {
    const legacy = yield* decodeLegacyContent(document);
    const apps: DeployedApp[] = legacy.apps.map((app) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        url: app.url,
        ogImageHosts:
            app.ogImageHosts ??
            (app.id === "blocky" && app.url === BLOCKY_URL ? [...BLOCKY_OG_IMAGE_HOSTS] : []),
    }));

    return {
        records: legacy.records,
        apps,
        openSource: legacy.openSource,
        socials: legacy.socials,
        uses: legacy.uses,
        notes: legacy.notes ?? [],
        experience: legacy.experience ?? DEFAULT_SITE_CONTENT.experience,
        facts: legacy.facts ?? DEFAULT_SITE_CONTENT.facts,
        updatedAt: legacy.updatedAt,
    } satisfies SiteContent;
});

/**
 * Today's content, migrated verbatim from the hard-coded page. This is what a
 * reader sees before the bot has ever written the document — and what the bot
 * pre-fills its modals with.
 */
export const DEFAULT_SITE_CONTENT: SiteContent = {
    records: { bench: 325, squat: 485, deadlift: 525 },
    apps: [
        {
            id: "blocky",
            name: "Blocky",
            description: "Live Notion data, turned into customizable website widgets.",
            url: "https://www.blocky.so",
            ogImageHosts: [...BLOCKY_OG_IMAGE_HOSTS],
        },
    ],
    openSource: [
        {
            id: "zed-herdr",
            name: "Zed Herdr",
            url: "https://github.com/ImArtisann/zed-herdr",
            description: "Keep workspaces in sync.",
        },
        {
            id: "herdr-workspace-launcher",
            name: "Herdr workspace launcher",
            url: "https://github.com/ImArtisann/herdr-workspace-launcher",
            description: "A keyboard-first directory picker.",
        },
    ],
    socials: [
        { id: "github", label: "GitHub", url: "https://github.com/ImArtisann", icon: "github" },
        { id: "x", label: "X / Twitter", url: "https://x.com/IArtisann", icon: "x" },
        { id: "email", label: "Email", url: "mailto:hello@artisann.dev", icon: "mail" },
    ],
    uses: {
        software: [
            { label: "Herdr" },
            { label: "Fresh editor" },
            { label: "Zen" },
            { label: "Pen.dev" },
            { label: "Ghostty" },
        ],
        hardware: [
            { label: "MacBook Pro M4" },
            { label: "MSI MAG401QR monitor" },
            { label: "Kanto YU2" },
        ],
        languages: [{ label: "Java" }, { label: "JS / TS" }, { label: "Go" }, { label: "Python" }],
    },
    notes: [],
    experience: [
        {
            id: "verizon",
            company: "Verizon",
            years: "2025 — Present",
            title: "Software Engineer",
        },
        {
            id: "recon-forensics",
            company: "Recon Forensics",
            years: "2025 — 2026",
            title: "Contractor",
        },
        {
            id: "perforce",
            company: "Perforce Software",
            years: "2021 — 2025",
            title: "Systems Engineer",
        },
    ],
    facts: [
        { id: "age", icon: "birthday", label: "27 years old" },
        { id: "cats", icon: "cats", label: "2 cats" },
        { id: "music", icon: "music", label: "EDM fan" },
        { id: "powerlifting", icon: "fitness", label: "Powerlifter, for fun" },
    ],
    updatedAt: null,
};

/**
 * Parse the modal's multi-line "What I use" text into entries. Each non-blank
 * line is one label. Returns `null` — never a partial list — when the input
 * exceeds the section cap or any label exceeds 60 characters.
 */
export function parseUseLines(text: string): UseItem[] | null {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    if (lines.length === 0 || lines.length > MAX_USE_ITEMS) return null;

    const items: UseItem[] = [];
    for (const line of lines) {
        if (line.length > 60) return null;
        items.push({ label: line });
    }
    return items;
}

/** The inverse of {@link parseUseLines}: the modal text representation. */
export function formatUseLines(items: readonly UseItem[]): string {
    return items.map((item) => item.label).join("\n");
}

/**
 * Read the site-content document through the Worker's KV binding.
 *
 * A missing key is a cold start and yields {@link DEFAULT_SITE_CONTENT}.
 * Corrupt data or a failed read fails the request — never a partial document,
 * never per-field defaults.
 */
export const readContent = Effect.fn("Presence.readContent")(function* (
    namespace: PresenceKvBinding,
) {
    const store = kvDocumentStore(namespace, CONTENT_KEY);
    const document = yield* store.read;
    if (Option.isNone(document)) return DEFAULT_SITE_CONTENT;
    return yield* decodeContentDocument(document.value);
});
