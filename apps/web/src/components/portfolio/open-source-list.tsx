/** @jsxImportSource react */
import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

/** The "Open source" card body: one entry per project, server-rendered then refreshed by the query. */
function OpenSourceListContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    if (content.openSource.length === 0) {
        return (
            <CardContent className="flex flex-col gap-2">
                <p className="text-caption text-muted-foreground">Nothing here yet.</p>
            </CardContent>
        );
    }

    return content.openSource.map((project) => (
        <CardContent key={project.id} className="flex flex-col gap-2">
            <h3>
                <a href={project.url} className="text-base font-medium text-primary">
                    {project.name} ↗
                </a>
            </h3>
            <p className="text-caption text-muted-foreground">{project.description}</p>
        </CardContent>
    ));
}

export function OpenSourceList(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <OpenSourceListContent {...props} />
        </SharedAtomRegistry>
    );
}
