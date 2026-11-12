import type { DeployedApp, OpenSourceProject } from "@artisann-port/portfolio-domain/content";
import { projectPreviewUrl } from "@artisann-port/presence/projects";

/** The preview image a project card renders, or `null` when it has none. */
export function projectImageSource(project: DeployedApp | OpenSourceProject): string | null {
    if ("ogImageHosts" in project) {
        const preview = new URL(projectPreviewUrl(project));
        return `${preview.pathname}${preview.search}`;
    }
    const url = new URL(project.url);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return owner === undefined || repo === undefined
        ? null
        : `https://opengraph.githubassets.com/1/${owner}/${repo}`;
}
