import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons-pro/core-solid-rounded";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";
import { useEffect, useRef, useState } from "react";

/** The "Open source" card body: every project, server-rendered then refreshed by the query. */
function OpenSourceListContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);
    const projects = content.openSource;
    const scrollRef = useRef<HTMLUListElement | null>(null);
    const [hasMore, setHasMore] = useState(false);

    // The fade is the only affordance that the list continues below the fold: it shows
    // whenever content overflows and the visitor has not reached the end.
    useEffect(() => {
        const el = scrollRef.current;
        if (el === null) return;
        const update = () => setHasMore(el.scrollTop + el.clientHeight < el.scrollHeight - 8);
        update();
        el.addEventListener("scroll", update, { passive: true });
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => {
            el.removeEventListener("scroll", update);
            observer.disconnect();
        };
    }, [projects.length]);

    return (
        <CardContent className="relative min-h-0 lg:flex-1">
            {projects.length === 0 ? (
                <p className="text-caption text-muted-foreground">Nothing here yet.</p>
            ) : (
                <>
                    <ul
                        ref={scrollRef}
                        tabIndex={0}
                        aria-label="Open source projects"
                        className="flex max-h-72 min-h-0 flex-col gap-4 overflow-y-auto outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:ring-2 focus-visible:ring-ring/50 lg:max-h-none lg:h-full"
                    >
                        {projects.map((project) => (
                            <li key={project.id} className="flex min-w-0 flex-col gap-1">
                                <h3>
                                    <a
                                        href={project.url}
                                        className="inline-flex min-h-11 max-w-full items-center text-base font-semibold text-primary wrap-anywhere lg:min-h-0"
                                    >
                                        {project.name}
                                        <HugeiconsIcon
                                            icon={ArrowUpRight01Icon}
                                            size={14}
                                            className="ml-1 shrink-0"
                                            aria-hidden="true"
                                        />
                                    </a>
                                </h3>
                                <p className="text-caption text-muted-foreground wrap-anywhere">
                                    {project.description}
                                </p>
                            </li>
                        ))}
                    </ul>
                    <div
                        aria-hidden="true"
                        className={cn(
                            "pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-t from-card to-transparent transition-opacity duration-300",
                            hasMore ? "opacity-100" : "opacity-0",
                        )}
                    />
                </>
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
