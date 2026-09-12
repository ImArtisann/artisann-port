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

interface ProjectPreviewImageProps {
    /** The Open Graph image URL; `null` renders the unavailable state without a request. */
    readonly src: string | null;
    readonly name: string;
    readonly url: string;
    /** Caption under the loading placeholder, e.g. "Website OG image". */
    readonly loadingLabel: string;
}

interface ProjectPreviewCarousel {
    readonly position: number;
    readonly count: number;
    readonly onStep: (delta: 1 | -1) => void;
}

interface ProjectPreviewControlsProps {
    /**
     * Carousel state when the preview browses a list of projects: the active index,
     * the total, and a stepper receiving ±1. Omitted for a single static preview —
     * the control row still renders, disabled, so the card keeps its height.
     */
    readonly carousel?: ProjectPreviewCarousel;
}

interface ProjectPreviewProps extends ProjectPreviewImageProps, ProjectPreviewControlsProps {}

/** The linked OG image with its loading and unavailable states. */
export function ProjectPreviewImage({ src, name, url, loadingLabel }: ProjectPreviewImageProps) {
    const [result, setResult] = useState<{ src: string; state: PreviewState } | null>(null);
    const state = src === null ? "failed" : result?.src === src ? result.state : "loading";
    // The <img> only mounts when src is non-null; bind it so callbacks keep a `string`.
    const imageSrc = src ?? "";

    // The island hydrates after the server-rendered <img> starts loading, so a cached preview can
    // finish before React attaches onLoad. Adopt whatever the element already settled on.
    const adoptLoaded = useCallback(
        (node: HTMLImageElement | null) => {
            if (node === null || !node.complete) return;
            const settled = node.naturalWidth === 0 ? "failed" : "loaded";
            setResult({ src: imageSrc, state: settled });
        },
        [imageSrc],
    );

    return (
        <a
            href={url}
            aria-label={`Visit ${name}`}
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
                            Preview unavailable · Visit {name}
                        </p>
                    </EmptyHeader>
                </Empty>
            ) : (
                <>
                    <img
                        ref={adoptLoaded}
                        src={imageSrc}
                        alt={`${name} Open Graph preview`}
                        width={1200}
                        height={630}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setResult({ src: imageSrc, state: "loaded" })}
                        onError={() => setResult({ src: imageSrc, state: "failed" })}
                        className={cn(
                            "size-full object-cover transition-opacity duration-200 ease-out",
                            state === "loading" && "opacity-0",
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
                                    {loadingLabel}
                                </p>
                            </EmptyHeader>
                        </Empty>
                    )}
                </>
            )}
        </a>
    );
}

/** The dots and chevrons under a preview. Static chrome: it never animates with the slide. */
export function ProjectPreviewControls({ carousel }: ProjectPreviewControlsProps) {
    return (
        <div className="flex h-11 items-center justify-between gap-3 lg:h-9">
            <span className="flex items-center gap-1.5" aria-hidden="true">
                {carousel === undefined ? (
                    /* A single preview never implies a carousel. */
                    <span className="h-1.25 w-4.5 rounded-full bg-foreground" />
                ) : (
                    Array.from({ length: carousel.count }, (_, index) => (
                        <span
                            key={index}
                            className={cn(
                                "h-1.25 rounded-full transition-[width] duration-200 ease-out",
                                index === carousel.position
                                    ? "w-4.5 bg-foreground"
                                    : "w-1.25 bg-muted-foreground/40",
                            )}
                        />
                    ))
                )}
            </span>
            <span className="flex items-center gap-3">
                <Button
                    variant="ghost"
                    size="icon-carousel"
                    disabled={carousel === undefined || carousel.count < 2}
                    aria-label={`Previous project`}
                    onClick={carousel === undefined ? undefined : () => carousel.onStep(-1)}
                >
                    <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-carousel"
                    disabled={carousel === undefined || carousel.count < 2}
                    aria-label={`Next project`}
                    onClick={carousel === undefined ? undefined : () => carousel.onStep(1)}
                >
                    <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
                </Button>
            </span>
        </div>
    );
}

/** Image plus control row, for cards that show one static preview. */
export function ProjectPreview({ src, name, url, loadingLabel, carousel }: ProjectPreviewProps) {
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <ProjectPreviewImage src={src} name={name} url={url} loadingLabel={loadingLabel} />
            <ProjectPreviewControls carousel={carousel} />
        </div>
    );
}
