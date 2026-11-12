import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@artisann-port/portfolio-domain/content";
import * as Effect from "effect/Effect";
import * as Server from "foldkit/experimental/server";
import { renderDocument } from "../src/entry.server.ts";
import { Flags, init } from "../src/main.ts";
import { view } from "../src/view.ts";

const content: SiteContent = {
    ...DEFAULT_SITE_CONTENT,
    records: { bench: 331, squat: 487, deadlift: 529 },
    apps: [
        {
            id: "published-app",
            name: "Published app",
            description: "An owner-edited project.",
            url: "https://editor.so",
            ogImageHosts: [],
        },
    ],
    openSource: [
        {
            id: "published-source",
            name: "Published source",
            description: "An owner-edited repository.",
            url: "https://github.com/ImArtisann/published",
        },
    ],
    facts: [{ id: "published-fact", icon: "cats", label: "A published personal fact" }],
    socials: [
        {
            id: "published-social",
            icon: "github",
            label: "Published social",
            url: "https://github.com/ImArtisann",
        },
    ],
    experience: [
        {
            id: "published-job",
            company: "Published company",
            years: "2024 — Present",
            title: "Published role",
        },
    ],
    uses: {
        software: [{ label: "Published editor" }],
        hardware: [{ label: "Published keyboard" }],
        languages: [{ label: "Published language" }],
    },
    notes: [
        {
            id: "published-note",
            name: "A visitor",
            body: "<script>alert('not markup')</script>",
            submittedAt: "2026-09-09T00:00:00.000Z",
            approvedAt: "2026-09-10T00:00:00.000Z",
        },
    ],
    updatedAt: "2026-09-10T00:00:00.000Z",
};
const flags: Flags = { content, siteKey: "", composerEnabled: false, year: 2026 };

afterEach(() => vi.unstubAllGlobals());

describe("build-rendered Foldkit portfolio", () => {
    it("renders every published section and safe note text without acquiring browser resources", async () => {
        let networkAcquisitions = 0;
        vi.stubGlobal("fetch", () => {
            networkAcquisitions += 1;
            throw new Error("SSR must not run browser commands");
        });
        vi.stubGlobal(
            "WebSocket",
            class {
                constructor() {
                    networkAcquisitions += 1;
                    throw new Error("SSR must not acquire subscriptions");
                }
            },
        );
        const rendered = await Effect.runPromise(
            Server.renderToString(
                { Flags, init, view },
                { flags, buildId: "portfolio-render-fixture" },
            ),
        );
        for (const value of [
            "331",
            "487",
            "529",
            "Published app",
            "Published source",
            "A published personal fact",
            "Published social",
            "Published company",
            "Published role",
            "Published editor",
            "Published keyboard",
            "Published language",
        ])
            expect(rendered.html).toContain(value);
        for (const section of [
            "site-navigation",
            "page-grid",
            "sidebar",
            "domains",
            "deployed-apps",
            "listening-notes",
            "socials",
            "open-source",
            "cat-gallery",
            "git-history",
            "personal-photos",
            "uses",
            "experience-socials",
            "work-experience",
            "status-weather",
            "visitor-notes",
            "bottom-contact",
            "footer",
        ])
            expect(rendered.html).toContain(`data-portfolio-section="${section}"`);
        for (const node of [
            "SGDDb",
            "OYWzR",
            "rN8gr",
            "uUTF6",
            "HBGRh",
            "FIClU",
            "i5zhN",
            "B2q4fP",
            "LWPRy",
            "Y5A1J",
            "I7lMtH",
            "lTwEH",
            "S3g7P",
            "nYszh",
            "P9RRLh",
            "s6ZG2G",
            "usrua",
            "tXZgT",
            "oaer3",
            "d6Lg3",
            "Ea0Rh",
        ])
            expect(rendered.html).toContain(`data-design-node="${node}"`);
        expect(rendered.html).toContain("&lt;script&gt;alert('not markup')&lt;/script&gt;");
        expect(rendered.html).not.toContain("<script>alert('not markup')</script>");
        expect(rendered.html).toContain("data-foldkit-app=");
        expect(rendered.html).toContain("data-foldkit-flags=");
        expect(networkAcquisitions).toBe(0);
    });

    it("delivers canonical and social metadata, a static Turnstile tag, and stored theme before paint", async () => {
        const rendered = await Effect.runPromise(
            Server.renderToString(
                { Flags, init, view },
                { flags, buildId: "portfolio-document-fixture" },
            ),
        );
        const document = renderDocument(rendered, {
            entryScript: "/assets/entry-fixture.js",
            stylesheets: ["/assets/style-fixture.css"],
            modulePreloads: [],
        });
        expect(document).toMatch(
            /<link rel="canonical" href="https:\/\/www\.artisann\.dev\/"\s*\/?>/u,
        );
        expect(document).toMatch(
            /<meta property="og:url" content="https:\/\/www\.artisann\.dev\/"\s*\/?>/u,
        );
        expect(document).toContain(
            '<meta property="og:title" content="Artisann | Developer &amp; Automation Architect">',
        );
        expect(document).toContain('<meta name="twitter:card" content="summary_large_image">');
        expect(document).toContain(
            '<meta property="og:image" content="https://assets.artisann.dev/',
        );
        expect(document).toContain(
            '<script defer src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>',
        );
        expect(document.indexOf('localStorage.getItem("theme")')).toBeLessThan(
            document.indexOf("<body>"),
        );
        expect(document).toContain(
            '<script type="module" crossorigin src="/assets/entry-fixture.js">',
        );
        expect(document).not.toContain("analytics-collect.artisann.dev/t.js");
    });
});
