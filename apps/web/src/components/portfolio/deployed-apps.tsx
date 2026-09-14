import type { SiteContent } from "@artisann-port/presence/content";
import { projectPreviewUrl } from "@artisann-port/presence/projects";
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
import { portfolioApiOrigin } from "@/lib/rpc-client";

const appVariants = {
    enter: (direction: number) => ({ x: direction > 0 ? 20 : -20, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (direction: number) => ({ x: direction > 0 ? -20 : 20, opacity: 0 }),
};
const reducedAppVariants = {
    enter: { x: 0, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: { x: 0, opacity: 0 },
};

/** The "Deployed apps" card body: one app at a time, browsed with the preview carousel. */
function DeployedAppsContent({ initial }: { initial: SiteContent }) {
    const content = useSiteContent(initial);
    const apps = content.apps;
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [direction, setDirection] = useState<1 | -1>(1);
    const reduceMotion = useReducedMotion();

    const index = Math.max(
        0,
        apps.findIndex((app) => app.id === selectedId),
    );
    const app = apps[index];

    const step = (delta: 1 | -1) => {
        const next = apps[(index + delta + apps.length) % apps.length];
        if (next !== undefined) {
            setDirection(delta);
            setSelectedId(next.id);
        }
    };

    if (app === undefined) {
        return (
            <CardContent>
                <p className="text-caption text-muted-foreground">Nothing deployed yet.</p>
            </CardContent>
        );
    }

    const label = new URL(app.url).hostname.replace(/^www\./, "");

    const transition = { duration: reduceMotion ? 0.1 : 0.25, ease: "easeOut" as const };
    const variants = reduceMotion ? reducedAppVariants : appVariants;

    return (
        <CardContent className="flex min-h-0 flex-col gap-3 lg:flex-1">
            {/* The image and the text slide; the dots and chevrons between them stay mounted. */}
            <div className="relative min-w-0 overflow-hidden">
                <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                    <motion.div
                        key={app.id}
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={transition}
                        className="will-change-transform"
                    >
                        <ProjectPreviewImage
                            src={projectPreviewUrl(app, portfolioApiOrigin)}
                            name={app.name}
                            url={app.url}
                            loadingLabel="Website OG image"
                        />
                    </motion.div>
                </AnimatePresence>
            </div>
            <ProjectPreviewControls
                carousel={{ position: index, count: apps.length, onStep: step }}
            />
            <div className="relative min-w-0 overflow-hidden" aria-live="polite">
                <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                    <motion.div
                        key={app.id}
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={transition}
                        className="flex min-w-0 flex-col gap-2 will-change-transform"
                    >
                        <div className="flex flex-col gap-1">
                            <h3 className="text-project font-semibold">{app.name}</h3>
                            <p className="text-label text-muted-foreground">{app.description}</p>
                        </div>
                        <a
                            href={app.url}
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

export function DeployedApps(props: { initial: SiteContent }) {
    return (
        <SharedAtomRegistry>
            <DeployedAppsContent {...props} />
        </SharedAtomRegistry>
    );
}
