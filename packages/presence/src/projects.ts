import type { DeployedApp } from "./content.ts";
import { PORTFOLIO_API_ORIGIN } from "./config.ts";

/**
 * Build the public preview URL for one published app.
 *
 * The version is an encoded representation of the only mutable inputs used
 * when fetching a preview. It is intentionally computed without Web Crypto:
 * this function runs during Astro SSR as well as in browser islands.
 */
export function projectPreviewUrl(app: DeployedApp, apiOrigin = PORTFOLIO_API_ORIGIN): string {
    const version = encodeURIComponent(JSON.stringify([app.url, app.ogImageHosts]));
    return new URL(`/projects/${encodeURIComponent(app.id)}/og-image?v=${version}`, apiOrigin).href;
}
