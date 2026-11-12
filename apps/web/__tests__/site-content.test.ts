import { afterEach, expect, it, vi } from "vite-plus/test";
import { loadSiteContent } from "../src/lib/site-content.ts";

afterEach(() => vi.unstubAllGlobals());

it("refuses corrupt published content instead of generating the site from seed data", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ records: "invalid document" })));

    await expect(loadSiteContent()).rejects.toMatchObject({
        _tag: "PortfolioApiError",
        operation: "/api/content",
    });
});
