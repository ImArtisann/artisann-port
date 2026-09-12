import type { SiteContent } from "@artisann-port/presence/content";
import { CardContent } from "@artisann-port/ui/components/card";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons-pro/core-solid-rounded";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import {
    ProjectPreviewControls,
    ProjectPreviewImage,
} from "@/components/portfolio/project-preview";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { useSiteContent } from "@/lib/content-client";

const projectVariants = {
    enter: (direction: number) => ({ x: direction > 0 ? 20 : -20, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (direction: number) => ({ x: direction > 0 ? -20 : 20, opacity: 0 }),
};
const reducedProjectVariants = {
    enter: { x: 0, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: { x: 0, opacity: 0 },
};

/**
 * GitHub serves a generated Open Graph card for every repository at
 * opengraph.githubassets.com/<hash>/<owner>/<repo>. Returns `null` for
 * non-GitHub URLs so the preview falls back to its unavailable state.
 */
function githubOgImageUrl(url: string): string | null {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (owner === undefined || repo === undefined) return null;
    return `https://opengraph.githubassets.com/1/${owner}/${repo}`;
}

/** The "Open source" card body: one project at a time, browsed with the preview carousel. */
function OpenSourceListContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);
    const projects = content.openSource;
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [direction, setDirection] = useState<1 | -1>(1);
    const reduceMotion = useReducedMotion();

    const index = Math.max(
        0,
        projects.findIndex((project) => project.id === selectedId),
    );
    const project = projects[index];

    const step = (delta: 1 | -1) => {
        const next = projects[(index + delta + projects.length) % projects.length];
        if (next !== undefined) {
            setDirection(delta);
            setSelectedId(next.id);
        }
    };

    if (project === undefined) {
        return (
            <CardContent>
                <p className="text-caption text-muted-foreground">Nothing here yet.</p>
            </CardContent>
        );
    }

    // The link caption: `owner/repo` for GitHub, otherwise the hostname.
    const parsed = new URL(project.url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const label =
        parsed.hostname === "github.com" && path.length > 0
            ? path
            : parsed.hostname.replace(/^www\./, "");

    const transition = { duration: reduceMotion ? 0.1 : 0.25, ease: "easeOut" as const };
    const variants = reduceMotion ? reducedProjectVariants : projectVariants;

    return (
        <CardContent className="flex min-h-0 flex-col gap-3 lg:flex-1">
            {/* The image and the text slide; the dots and chevrons between them stay mounted. */}
            <div className="relative min-w-0 overflow-hidden">
                <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                    <motion.div
                        key={project.id}
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={transition}
                        className="will-change-transform"
                    >
                        <ProjectPreviewImage
                            src={githubOgImageUrl(project.url)}
                            name={project.name}
                            url={project.url}
                            loadingLabel="GitHub OG image"
                        />
                    </motion.div>
                </AnimatePresence>
            </div>
            <ProjectPreviewControls
                name={project.name}
                carousel={{ position: index, count: projects.length, onStep: step }}
            />
            <div className="relative min-w-0 overflow-hidden" aria-live="polite">
                <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                    <motion.div
                        key={project.id}
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={transition}
                        className="flex min-w-0 flex-col gap-2 will-change-transform"
                    >
                        <div className="flex flex-col gap-1">
                            <h3 className="text-project font-semibold">{project.name}</h3>
                            <p className="text-label text-muted-foreground">
                                {project.description}
                            </p>
                        </div>
                        <a
                            href={project.url}
                            className="flex h-11 items-center text-caption font-medium text-primary lg:h-auto"
                        >
                            {label}
                            <HugeiconsIcon
                                icon={ArrowUpRight01Icon}
                                size={12}
                                className="ml-1"
                                aria-hidden="true"
                            />
                        </a>
                    </motion.div>
                </AnimatePresence>
            </div>
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
