import { SharedAtomRegistry } from "@/lib/atom-registry";
import { cn } from "@artisann-port/ui/lib/utils";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from "@artisann-port/ui/components/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImagesIcon, ImageNotFound01Icon } from "@hugeicons-pro/core-solid-rounded";
import type { ComponentPropsWithoutRef } from "react";
import { PhotoDeck, useGallerySelection } from "./photo-deck.tsx";

/**
 * The life-photo sidebar. It exists twice on the page — once for desktop, once for
 * mobile — and each placement owns its own selection state.
 */
export type LifeGalleryVariant = "desktop" | "mobile";

type LifeGalleryProps = {
    variant: LifeGalleryVariant;
    /** Public RPC endpoint; defaults to the production Worker route. */
    endpoint?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "children">;

function LifeGalleryInner({ variant, endpoint, ...rest }: LifeGalleryProps) {
    const { photos, position, current, unavailable, step } = useGallerySelection("life", endpoint);
    const count = photos.length;
    const alt = current === undefined ? "Life photos" : `Life photo ${position + 1} of ${count}`;

    const frame =
        "relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40";
    const sidebarSize =
        variant === "desktop"
            ? "h-85 max-h-110 flex-none gap-2 max-lg:hidden"
            : "aspect-4/5 max-h-110 flex-none gap-2 lg:hidden";

    const activeImage =
        current === undefined ? null : (
            <PhotoDeck photos={photos} position={position} photoNoun="Life photo" navigate={step} />
        );

    // Keep the existing empty treatment and frame size; populated galleries are
    // browsed by swipe.
    if (count === 0) {
        return (
            <Empty
                {...rest}
                className={
                    rest.className !== undefined ? `${rest.className} ${sidebarSize}` : sidebarSize
                }
                role={unavailable ? "status" : undefined}
            >
                <EmptyHeader>
                    <EmptyMedia>
                        <HugeiconsIcon icon={ImagesIcon} size={26} aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyDescription className={variant === "desktop" ? "text-aside" : undefined}>
                        {unavailable
                            ? "Life photos are temporarily unavailable."
                            : "A few moments from my life"}
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div
            role="group"
            aria-label="Life photo carousel, swipe to browse"
            {...rest}
            className={cn(
                "flex min-w-0 flex-none flex-col",
                variant === "desktop" ? "max-lg:hidden" : "lg:hidden",
                rest.className,
            )}
        >
            <div className={`${frame} ${sidebarSize} w-full p-2.5`}>
                {activeImage ?? (
                    <div className="flex flex-col items-center gap-2">
                        <HugeiconsIcon icon={ImageNotFound01Icon} size={26} aria-hidden="true" />
                        <p className="text-image-caption text-muted-foreground">
                            Photo unavailable
                        </p>
                    </div>
                )}
            </div>
            <p
                role="status"
                aria-live="polite"
                className={cn(
                    "text-image-caption text-muted-foreground",
                    !unavailable && "sr-only",
                )}
            >
                {current === undefined ? "" : `${alt}. `}
                {unavailable ? "Photo updates are temporarily unavailable." : ""}
            </p>
        </div>
    );
}

export function LifeGallery(props: LifeGalleryProps) {
    return (
        <SharedAtomRegistry>
            <LifeGalleryInner {...props} />
        </SharedAtomRegistry>
    );
}
