import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons-pro/core-solid-rounded";
import { ProjectPreview } from "@/components/portfolio/project-preview";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

/** The "Deployed apps" card body: preview, name/description and visit link for every app. */
function DeployedAppsContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    if (content.apps.length === 0) {
        return (
            <CardContent>
                <p className="text-caption text-muted-foreground">Nothing deployed yet.</p>
            </CardContent>
        );
    }

    return content.apps.map((app, position) => {
        return (
            <div
                key={app.id}
                className={cn(
                    "flex min-w-0 flex-col gap-6",
                    position > 0 && "border-t border-border pt-4",
                )}
            >
                <CardContent>
                    <ProjectPreview app={app} />
                </CardContent>
                <CardContent className="flex flex-col gap-2">
                    <div className="flex flex-col gap-1">
                        <h3 className="text-project font-semibold">{app.name}</h3>
                        <p className="text-label text-muted-foreground">{app.description}</p>
                    </div>
                    <a
                        href={app.url}
                        className="flex h-11 items-center text-caption font-medium text-primary lg:h-auto"
                    >
                        {new URL(app.url).hostname.replace(/^www\./, "")}
                        <HugeiconsIcon
                            icon={ArrowUpRight01Icon}
                            size={12}
                            className="ml-1"
                            aria-hidden="true"
                        />
                    </a>
                </CardContent>
            </div>
        );
    });
}

export function DeployedApps(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <DeployedAppsContent {...props} />
        </SharedAtomRegistry>
    );
}
