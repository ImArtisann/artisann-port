import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { DEFAULT_SITE_CONTENT, type DeployedApp } from "../src/content.ts";
import { isPublicDnsHostname, parseOgImageHosts } from "../src/project-hosts.ts";
import { projectPreviewResponse, type ProjectImageCache } from "../src/project-preview.ts";
import { projectPreviewUrl } from "../src/projects.ts";

const app: DeployedApp = {
    id: "example",
    name: "Example",
    description: "An app",
    url: "https://example.com",
    ogImageHosts: ["images.example.com"],
};

describe("project OG authority", () => {
    it("normalizes optional approved hosts but refuses URLs, addresses and local names", () => {
        expect(
            parseOgImageHosts(" Images.Example.COM \nimages.example.com\ncdn.example.com"),
        ).toEqual(["images.example.com", "cdn.example.com"]);
        expect(parseOgImageHosts(" \n")).toEqual([]);
        for (const input of [
            "https://example.com",
            "example.com/path",
            "example.com:443",
            "user@example.com",
            "*.example.com",
            "127.0.0.1",
            "[::1]",
            "localhost",
            "host.internal",
            "host.local",
            "0x7f000001",
        ]) {
            expect(parseOgImageHosts(input), input).toBeNull();
            expect(isPublicDnsHostname(input), input).toBe(false);
        }
    });

    it("versions preview URLs by stored destinations and image approvals", () => {
        const original = projectPreviewUrl(app);
        expect(projectPreviewUrl({ ...app, name: "Renamed" })).toBe(original);
        expect(projectPreviewUrl({ ...app, url: "https://other.example.com" })).not.toBe(original);
        expect(projectPreviewUrl({ ...app, ogImageHosts: [] })).not.toBe(original);
    });

    it("uses stored content for cache identity and refuses removed ids before fetching", async () => {
        const keys: string[] = [];
        let upstream = 0;
        const cache: ProjectImageCache = {
            match: async (request) => {
                keys.push(request.url);
                return new Response(new Uint8Array([1, 2]), {
                    headers: { "content-type": "image/png" },
                });
            },
            put: async () => {
                throw new Error("Unexpected cache write");
            },
        };
        const client = HttpClient.make(() =>
            Effect.sync(() => {
                upstream++;
                throw new Error("Unexpected provider fetch");
            }),
        );
        const content = { ...DEFAULT_SITE_CONTENT, apps: [app] };
        const response = await Effect.runPromise(
            projectPreviewResponse(
                new Request(
                    "https://presence.artisann.dev/projects/example/og-image?v=forged&url=https://127.0.0.1",
                ),
                cache,
                content,
            ).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        );
        expect(response.status).toBe(200);
        expect(keys).toEqual([projectPreviewUrl(app)]);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        const removed = await Effect.runPromise(
            projectPreviewResponse(new Request(projectPreviewUrl(app)), cache, {
                ...content,
                apps: [],
            }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        );
        expect(removed.status).toBe(404);
        expect(keys).toHaveLength(1);
        expect(upstream).toBe(0);
    });
});
