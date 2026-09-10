import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CONTENT_KEY } from "../src/config.ts";
import {
    DEFAULT_SITE_CONTENT,
    MAX_APPS,
    MAX_EXPERIENCE,
    MAX_FACTS,
    MAX_NOTES,
    SiteContent,
    decodeContentDocument,
    formatUseLines,
    parseUseLines,
    readContent,
} from "../src/content.ts";
import { photoKey, photoUrl } from "../src/photos.ts";
import type { PresenceKvBinding } from "../src/store.ts";

const HOST = "assets.artisann.dev";

const validate = Schema.decodeUnknownPromise(SiteContent);

/** A valid stored note body is at most 120 characters after normalization. */
const note = (id: string, body = "A kind note") => ({
    id,
    name: null,
    body,
    submittedAt: "2026-09-08T03:00:00.000Z",
    approvedAt: "2026-09-08T03:01:00.000Z",
});

const app = (id: string) => ({
    id,
    name: "App",
    description: "A deployed app",
    url: "https://example.com",
    ogImageHosts: [],
});

describe("site content document decode", () => {
    it("migrates absent notes, experience, facts, and OG hosts from old storage", async () => {
        const {
            notes: _notes,
            experience: _experience,
            facts: _facts,
            ...withoutNewFields
        } = DEFAULT_SITE_CONTENT;
        const { ogImageHosts: _hosts, ...oldApp } = DEFAULT_SITE_CONTENT.apps[0]!;
        const old = {
            ...withoutNewFields,
            apps: [{ ...oldApp, screenshots: [] }],
        };
        const document = await Effect.runPromise(decodeContentDocument(JSON.stringify(old)));

        expect(document.notes).toEqual([]);
        expect(document.experience).toEqual(DEFAULT_SITE_CONTENT.experience);
        expect(document.facts).toEqual(DEFAULT_SITE_CONTENT.facts);
        expect(document.apps[0]?.ogImageHosts).toEqual([
            "assets.blocky.so",
            "www.blocky.so",
            "blocky.so",
        ]);
    });

    it("does not default missing fields at the canonical schema boundary", async () => {
        const { notes: _notes, ...withoutNotes } = DEFAULT_SITE_CONTENT;
        await expect(validate(withoutNotes)).rejects.toThrow();
    });

    it("rejects a present invalid notes field instead of repairing it", async () => {
        const corrupt = {
            ...DEFAULT_SITE_CONTENT,
            notes: [{ ...note("n1"), body: "" }],
        };

        await expect(validate(corrupt)).rejects.toThrow();
    });

    it("preserves valid legacy notes and authored data during migration", async () => {
        const { experience: _experience, facts: _facts, ...oldBase } = DEFAULT_SITE_CONTENT;
        const old = { ...oldBase, notes: [note("persisted", "Keep this note")] };
        const migrated = await Effect.runPromise(decodeContentDocument(JSON.stringify(old)));
        expect(migrated.notes).toEqual([note("persisted", "Keep this note")]);
        expect(migrated.records).toEqual(DEFAULT_SITE_CONTENT.records);
        expect(migrated.uses).toEqual(DEFAULT_SITE_CONTENT.uses);
    });

    it("accepts a 120-character body and rejects a 121-character body", async () => {
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, notes: [note("n1", "a".repeat(120))] }),
        ).resolves.toBeTruthy();
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, notes: [note("n1", "a".repeat(121))] }),
        ).rejects.toThrow();
    });

    it("rejects duplicate note ids", async () => {
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, notes: [note("n1"), note("n1")] }),
        ).rejects.toThrow();
    });

    it("accepts MAX_NOTES notes and rejects one more", async () => {
        const full = Array.from({ length: MAX_NOTES }, (_, index) => note(`n${index}`));
        await expect(validate({ ...DEFAULT_SITE_CONTENT, notes: full })).resolves.toBeTruthy();
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, notes: [...full, note("overflow")] }),
        ).rejects.toThrow();
    });

    it("rejects duplicate ids inside an entry array", async () => {
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, apps: [app("blocky"), app("blocky")] }),
        ).rejects.toThrow();
    });

    it("accepts MAX_APPS apps and rejects a 26th", async () => {
        const full = Array.from({ length: MAX_APPS }, (_, index) => app(`a${index}`));
        await expect(validate({ ...DEFAULT_SITE_CONTENT, apps: full })).resolves.toBeTruthy();
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, apps: [...full, app("a26")] }),
        ).rejects.toThrow();
    });

    it("accepts capped experience and facts lists and rejects overflow", async () => {
        const experience = Array.from({ length: MAX_EXPERIENCE }, (_, index) => ({
            id: `experience-${index}`,
            company: "Company",
            years: "2025",
            title: "Engineer",
        }));
        const facts = Array.from({ length: MAX_FACTS }, (_, index) => ({
            id: `fact-${index}`,
            icon: "cats" as const,
            label: "Fact",
        }));
        await expect(
            validate({ ...DEFAULT_SITE_CONTENT, experience, facts }),
        ).resolves.toBeTruthy();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                experience: [...experience, { ...experience[0]!, id: "experience-overflow" }],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                facts: [...facts, { ...facts[0]!, id: "fact-overflow" }],
            }),
        ).rejects.toThrow();
    });

    it("rejects an http: app url and a javascript: social url", async () => {
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [{ ...app("blocky"), url: "http://example.com" }],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                socials: [{ id: "x", label: "X", url: "javascript:alert(1)", icon: "x" }],
            }),
        ).rejects.toThrow();
    });

    it("requires canonical public DNS OG hosts", async () => {
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [{ ...app("blocky"), ogImageHosts: ["cdn.example.com", "CDN.example.com"] }],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [{ ...app("blocky"), ogImageHosts: ["127.0.0.1"] }],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [
                    {
                        ...app("blocky"),
                        ogImageHosts: Array.from(
                            { length: 9 },
                            (_, index) => `cdn${index}.example.com`,
                        ),
                    },
                ],
            }),
        ).rejects.toThrow();
    });

    it("accepts mailto: only for socials", async () => {
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [{ ...app("blocky"), url: "mailto:hello@artisann.dev" }],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                socials: [
                    { id: "email", label: "Email", url: "mailto:hello@artisann.dev", icon: "mail" },
                ],
            }),
        ).resolves.toBeTruthy();
    });

    it("validates legacy screenshots before dropping them during migration", async () => {
        const old = {
            ...DEFAULT_SITE_CONTENT,
            apps: [
                {
                    ...app("other"),
                    screenshots: [
                        {
                            key: "apps/other/1234567890123456789.webp",
                            url: "https://assets.artisann.dev/x.webp",
                            width: 1,
                            height: 1,
                            alt: "Screenshot",
                        },
                    ],
                },
            ],
        };
        const migrated = await Effect.runPromise(decodeContentDocument(JSON.stringify(old)));
        expect(migrated).toMatchObject({ apps: [{ ogImageHosts: [] }] });
        expect(migrated.apps[0]).not.toHaveProperty("screenshots");
    });

    it("rejects an invalid legacy screenshot rather than repairing it", async () => {
        const { ogImageHosts: _hosts, ...withoutHosts } = DEFAULT_SITE_CONTENT.apps[0]!;
        const old = {
            ...DEFAULT_SITE_CONTENT,
            apps: [
                {
                    ...withoutHosts,
                    screenshots: [
                        {
                            key: "not-managed",
                            url: "https://example.com",
                            width: 1,
                            height: 1,
                            alt: "Bad",
                        },
                    ],
                },
            ],
        };
        await expect(
            Effect.runPromise(decodeContentDocument(JSON.stringify(old))),
        ).rejects.toThrow();
    });
});

describe("what I use modal text", () => {
    it("parses labels and notes, dropping blank lines", () => {
        expect(parseUseLines("JS / TS — Effect highly pilled\n\nGo")).toEqual([
            { label: "JS / TS", note: "Effect highly pilled" },
            { label: "Go", note: null },
        ]);
    });

    it("accepts the -- separator form", () => {
        expect(parseUseLines("Ghostty -- terminal")).toEqual([
            { label: "Ghostty", note: "terminal" },
        ]);
    });

    it("round-trips through formatUseLines", async () => {
        const items = parseUseLines("JS / TS — Effect highly pilled\nGo")!;
        expect(formatUseLines(items)).toBe("JS / TS — Effect highly pilled\nGo");
        expect(parseUseLines(formatUseLines(items))).toEqual(items);
    });

    it("returns null for a 61-character label, a 61-character note, or too many lines", async () => {
        expect(parseUseLines("a".repeat(61))).toBeNull();
        expect(parseUseLines(`Label — ${"a".repeat(61)}`)).toBeNull();
        expect(
            parseUseLines(Array.from({ length: 26 }, (_, i) => `Item ${i}`).join("\n")),
        ).toBeNull();
    });
});

describe("managed photo keys and urls", () => {
    it("builds a managed key from a valid tag and interaction id", async () => {
        expect(photoKey("life", "1234567890123456789")).toBe("life/1234567890123456789.webp");
        expect(photoKey("cats", "1234567890123456789")).toBe("cats/1234567890123456789.webp");
    });

    it("returns null for invalid tags, ids, keys, or hosts", async () => {
        expect(photoKey("life", "123")).toBeNull();
        expect(photoUrl("dogs/1234567890123456789.webp", HOST)).toBeNull();
        expect(photoUrl("life/1234567890123456789.webp", "http://evil.example")).toBeNull();
        expect(photoUrl("life/1234567890123456789.webp", HOST)).toBe(
            `https://${HOST}/life/1234567890123456789.webp`,
        );
    });
});

describe("full-string key and id validation", () => {
    it("rejects line terminators in ids and keys", async () => {
        expect(photoKey("life", "1234567890123456789\n")).toBeNull();
        expect(photoKey("life", "1234567890123456789\n" + "0")).toBeNull();
        expect(photoUrl("life/1234567890123456789.webp\n", HOST)).toBeNull();
        expect(photoUrl("life/123456789012345678\n.webp", HOST)).toBeNull();
    });

    it("rejects padded entry ids and urls at the schema boundary", async () => {
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                socials: [
                    {
                        id: "x\n",
                        label: "X",
                        url: "https://x.com/IArtisann",
                        icon: "x",
                    },
                ],
            }),
        ).rejects.toThrow();
        await expect(
            validate({
                ...DEFAULT_SITE_CONTENT,
                apps: [{ ...app("blocky"), url: "https://example.com\n" }],
            }),
        ).rejects.toThrow();
    });
});

/** An in-memory KV namespace double: read-only for the Worker under test. */
function memoryNamespace(documents: Record<string, string>): PresenceKvBinding & {
    writes: number;
} {
    let writes = 0;
    return {
        get: (key) => Promise.resolve(documents[key] ?? null),
        put: (key, value) => {
            writes += 1;
            documents[key] = value;
            return Promise.resolve();
        },
        get writes() {
            return writes;
        },
    };
}

describe("readContent native KV adapter", () => {
    it("serves DEFAULT_SITE_CONTENT when the key has never been written", async () => {
        await expect(Effect.runPromise(readContent(memoryNamespace({})))).resolves.toEqual(
            DEFAULT_SITE_CONTENT,
        );
    });

    it("serves the stored document when it decodes", async () => {
        await expect(
            Effect.runPromise(
                readContent(
                    memoryNamespace({ [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT) }),
                ),
            ),
        ).resolves.toEqual(DEFAULT_SITE_CONTENT);
    });

    it("fails without defaults for a corrupt document", async () => {
        await expect(
            Effect.runPromise(
                readContent(memoryNamespace({ [CONTENT_KEY]: "{definitely not json" })),
            ),
        ).rejects.toThrow();
    });

    it("never mutates storage while reading", async () => {
        const namespace = memoryNamespace({});
        await Effect.runPromise(readContent(namespace));

        expect(namespace.writes).toBe(0);
    });
});
