import { PRESENCE_URL } from "./config.ts";

export const DEPLOYED_PROJECTS = [
    {
        id: "blocky",
        name: "Blocky",
        href: "https://www.blocky.so",
        description: "Live Notion data, turned into customizable website widgets.",
        imageHosts: ["assets.blocky.so", "www.blocky.so", "blocky.so"],
    },
] as const;

export type DeployedProject = (typeof DEPLOYED_PROJECTS)[number];

export function projectPreviewUrl(project: DeployedProject): string {
    return `${PRESENCE_URL}projects/${project.id}/og-image`;
}
