import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@artisann-port/portfolio-domain/content";
import { init, Message, update, type Model } from "../src/main.ts";
import { projectImageSource } from "../src/lib/project-image.ts";

const content = (updatedAt: string, bench: number): SiteContent => ({
    ...DEFAULT_SITE_CONTENT,
    updatedAt,
    records: { ...DEFAULT_SITE_CONTENT.records, bench },
});

const run = (initial: SiteContent, messages: ReadonlyArray<Message>): Model =>
    messages.reduce(
        (model, message) => update(model, message).model,
        init({ content: initial, siteKey: "", composerEnabled: false, year: 2026 }).model,
    );

describe("portfolio application state", () => {
    it("keeps newer HTTP content when the watch delivers an older snapshot", () => {
        const newer = content("2026-11-12T04:00:00.000Z", 335);
        const model = run(content("2026-11-10T00:00:00.000Z", 315), [
            Message.ReceivedContent({ content: newer }),
            Message.ReceivedPublished({
                content: content("2026-11-11T00:00:00.000Z", 325),
                revision: 1,
            }),
        ]);
        expect(model.content).toEqual(newer);
    });

    it("retries a failed project preview when the carousel returns to it", () => {
        const [first, second] = DEFAULT_SITE_CONTENT.openSource;
        if (first === undefined || second === undefined) throw new Error("fixture needs two");
        const src = projectImageSource(first);
        if (src === null) throw new Error("fixture needs a preview image");
        const model = run(DEFAULT_SITE_CONTENT, [
            Message.SettledImage({ src, failed: true }),
            Message.StepProject({ kind: "openSource", delta: 1 }),
            Message.StepProject({ kind: "openSource", delta: -1 }),
        ]);
        expect(model.openSourceId).toBe(first.id);
        expect(model.failedImages).not.toContain(src);
    });
});
