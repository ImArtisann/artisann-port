/** @jsxImportSource react */
import { projectPreviewUrl, type DeployedProject } from "@artisann-port/presence/projects";
import { Button } from "@artisann-port/ui/components/button";
import { Empty, EmptyHeader, EmptyMedia } from "@artisann-port/ui/components/empty";
import { cn } from "@artisann-port/ui/lib/utils";
import {
    Album01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ImageNotFound01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState } from "react";

/** Open Graph images are served at 1200×630; the slot reserves that ratio before the image lands. */
const PREVIEW_RATIO = "aspect-[1200/630]";

type PreviewState = "loading" | "loaded" | "failed";

export function ProjectPreview({ project }: { project: DeployedProject }) {
    const src = projectPreviewUrl(project);
    const [result, setResult] = useState<{ src: string; state: PreviewState } | null>(null);
    const state = result?.src === src ? result.state : "loading";

    // The island hydrates after the server-rendered <img> starts loading, so a cached preview can
    // finish before React attaches onLoad. Adopt whatever the element already settled on.
    const adoptLoaded = useCallback(
        (node: HTMLImageElement | null) => {
            if (node === null || !node.complete) return;
            const settled = node.naturalWidth === 0 ? "failed" : "loaded";
            setResult({ src, state: settled });
        },
        [src],
    );

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <a
                href={project.href}
                aria-label={`Visit ${project.name}`}
                className={cn(
                    "relative block w-full overflow-hidden rounded-xl bg-muted",
                    PREVIEW_RATIO,
                )}
            >
                {state === "failed" ? (
                    <Empty className="absolute inset-0 rounded-xl">
                        <EmptyHeader>
                            <EmptyMedia>
                                <HugeiconsIcon
                                    icon={ImageNotFound01Icon}
                                    size={28}
                                    aria-hidden="true"
                                />
                            </EmptyMedia>
                            <p className="text-image-caption text-muted-foreground">
                                Preview unavailable · Visit {project.name}
                            </p>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <>
                        <img
                            ref={adoptLoaded}
                            src={src}
                            alt={`${project.name} Open Graph preview`}
                            width={1200}
                            height={630}
                            loading="lazy"
                            decoding="async"
                            onLoad={() => setResult({ src, state: "loaded" })}
                            onError={() => setResult({ src, state: "failed" })}
                            className={cn(
                                "size-full object-cover",
                                state === "loading" && "invisible",
                            )}
                        />
                        {state === "loading" && (
                            <Empty className="absolute inset-0 rounded-xl" role="status">
                                <EmptyHeader>
                                    <EmptyMedia>
                                        <HugeiconsIcon
                                            icon={Album01Icon}
                                            size={28}
                                            aria-hidden="true"
                                        />
                                    </EmptyMedia>
                                    <p className="text-image-caption text-muted-foreground">
                                        Website OG image
                                    </p>
                                </EmptyHeader>
                            </Empty>
                        )}
                    </>
                )}
            </a>
            <div className="flex h-11 items-center justify-between gap-3 lg:h-9">
                {/* One deployed project, so one slide marker: the row never implies images that do not exist. */}
                <span className="flex items-center gap-1.5" aria-hidden="true">
                    <span className="h-1.25 w-4.5 rounded-full bg-foreground" />
                </span>
                <span className="flex items-center gap-3">
                    <Button
                        variant="ghost"
                        size="icon-carousel"
                        disabled
                        aria-label="Previous project image"
                    >
                        <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-carousel"
                        disabled
                        aria-label="Next project image"
                    >
                        <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
                    </Button>
                </span>
            </div>
        </div>
    );
}
