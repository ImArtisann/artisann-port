import { env } from "cloudflare:workers";
import * as Server from "foldkit/experimental/server";
import { SITE_MARK_URL } from "./contracts.ts";
import { handleCatsRequest, type CatsRenderedApplication, type CatsWorkerEnv } from "./ssr.ts";

declare global {
    namespace Cloudflare {
        interface Env extends CatsWorkerEnv {}
    }
}

export const renderPage = (request: Request) => handleCatsRequest(request, env);

const escapeAttribute = (value: string) =>
    value.replace(/[&<>"']/gu, (character) => {
        switch (character) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&#39;";
        }
    });

export const renderDocument = (
    application: CatsRenderedApplication,
    assets: Server.DocumentAssets,
) => {
    const description = "Swipe through Jake's cat photos, heart the good ones, and leave a note.";
    const social = application.social;
    const head = [
        `<meta name="description" content="${escapeAttribute(description)}">`,
        '<meta name="theme-color" content="#faf3ea" media="(prefers-color-scheme: light)">',
        '<meta name="theme-color" content="#171310" media="(prefers-color-scheme: dark)">',
        '<meta property="og:title" content="Jake\'s Cats">',
        `<meta property="og:description" content="${escapeAttribute(description)}">`,
        '<meta property="og:type" content="website">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<link rel="icon" type="image/webp" href="${escapeAttribute(SITE_MARK_URL)}">`,
        ...(social === undefined
            ? []
            : [
                  `<meta property="og:image" content="${escapeAttribute(social.image)}">`,
                  `<meta property="og:image:alt" content="${escapeAttribute(social.alt)}">`,
                  `<meta name="twitter:image" content="${escapeAttribute(social.image)}">`,
                  `<meta name="twitter:image:alt" content="${escapeAttribute(social.alt)}">`,
              ]),
    ].join("");
    return Server.renderDocument(application, assets, { head }).replace(
        'content="width=device-width, initial-scale=1.0"',
        'content="width=device-width, initial-scale=1, viewport-fit=cover"',
    );
};
