import * as Effect from "effect/Effect";
import * as Server from "foldkit/experimental/server";
import type { SiteContent } from "@artisann-port/portfolio-domain/content";
import { Flags, init } from "./main.ts";
import { loadSiteContent } from "./lib/site-content.ts";
import { view } from "./view.ts";

export interface PortfolioFetcher {
    fetch(request: Request): Promise<Response>;
}
export interface PortfolioEnvironment {
    readonly PORTFOLIO: PortfolioFetcher;
}

export const isPortfolioRequest = (request: Request): boolean => {
    const path = new URL(request.url).pathname;
    return (
        path === "/api" ||
        path.startsWith("/api/") ||
        path === "/presence" ||
        /^\/projects\/[^/]+\/og-image$/u.test(path)
    );
};

let initialContent: Promise<SiteContent> | undefined;

export const handlePortfolioRequest = async (request: Request): Promise<Server.EntryResult> => {
    if (new URL(request.url).pathname !== "/")
        return Server.Responded(new Response("Not found", { status: 404 }));
    if (request.method !== "GET" && request.method !== "HEAD")
        return Server.Responded(
            new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }),
        );
    initialContent ??= loadSiteContent();
    const content = await initialContent;
    const siteKey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
    const application = await Effect.runPromise(
        Server.renderToString(
            { Flags, init, view },
            {
                flags: {
                    content,
                    siteKey,
                    composerEnabled:
                        siteKey !== "" && import.meta.env.PUBLIC_NOTES_COMPOSER === "enabled",
                    year: new Date().getUTCFullYear(),
                },
            },
        ),
    );
    return Server.Rendered(application);
};
