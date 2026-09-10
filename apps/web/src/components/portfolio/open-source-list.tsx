/** @jsxImportSource react */
import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

/** The "Open source" card body: one entry per project, server-rendered then refreshed by the query. */
function OpenSourceListContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);

    return (
        <CardContent className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] lg:contain-size [&::-webkit-scrollbar]:hidden">
            {content.openSource.length === 0 ? (
                <p className="text-caption text-muted-foreground">Nothing here yet.</p>
            ) : (
                <ul className="flex flex-col gap-4">
                    {content.openSource.map((project) => (
                        <li key={project.id} className="flex min-w-0 flex-col gap-1">
                            <h3>
                                <a
                                    href={project.url}
                                    className="inline-flex min-h-11 max-w-full items-center text-base font-semibold text-primary wrap-anywhere lg:min-h-0"
                                >
                                    {project.name} ↗
                                </a>
                            </h3>
                            <p className="text-caption text-muted-foreground wrap-anywhere">
                                {project.description}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </CardContent>
    );
}

export function OpenSourceList(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <OpenSourceListContent {...props} />
        </SharedAtomRegistry>
    );
}
