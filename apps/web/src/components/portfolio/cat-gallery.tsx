import { SharedAtomRegistry } from "@/lib/atom-registry";
import { CardContent } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import { Empty, EmptyDescription, EmptyMedia } from "@artisann-port/ui/components/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImagesIcon, ImageNotFound01Icon } from "@hugeicons-pro/core-solid-rounded";
import type { ComponentPropsWithoutRef } from "react";
import { PhotoDeck, useGallerySelection } from "./photo-deck.tsx";

type CatGalleryProps = {
    /** Public RPC endpoint; defaults to the production Worker route. */
    endpoint?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "children">;

/** The cat-photo bento card body. */
function CatGalleryInner({ endpoint, ...rest }: CatGalleryProps) {
    const { photos, position, current, unavailable, step } = useGallerySelection("cats", endpoint);
    const count = photos.length;
    const alt = current === undefined ? "Cat photos" : `Cat photo ${position + 1} of ${count}`;

    const frame =
        "relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40";

    const activeImage =
        current === undefined ? null : (
            <PhotoDeck photos={photos} position={position} photoNoun="Cat photo" navigate={step} />
        );

    return (
        <CardContent
            {...rest}
            className={cn("relative flex min-h-0 flex-1 flex-col", rest.className)}
        >
            {count === 0 ? (
                <Empty
                    className="aspect-4/5 min-h-0 flex-1 gap-3"
                    role={unavailable ? "status" : undefined}
                >
                    <EmptyMedia>
                        <HugeiconsIcon icon={ImagesIcon} size={32} aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyDescription>
                        {unavailable
                            ? "Cat photos are temporarily unavailable."
                            : "Cat photos go here"}
                    </EmptyDescription>
                </Empty>
            ) : (
                <div
                    role="group"
                    aria-label="Cat photo carousel, swipe to browse"
                    className={`${frame} aspect-4/5 w-full shrink-0`}
                >
                    {activeImage ?? (
                        <div className="flex flex-col items-center gap-2">
                            <HugeiconsIcon
                                icon={ImageNotFound01Icon}
                                size={28}
                                aria-hidden="true"
                            />
                            <p className="text-image-caption text-muted-foreground">
                                Photo unavailable
                            </p>
                        </div>
                    )}
                </div>
            )}
            <p role="status" aria-live="polite" className="sr-only">
                {current === undefined ? "" : `${alt}. `}
                {unavailable ? "Photo updates are temporarily unavailable." : ""}
            </p>
        </CardContent>
    );
}

export function CatGallery(props: CatGalleryProps) {
    return (
        <SharedAtomRegistry>
            <CatGalleryInner {...props} />
        </SharedAtomRegistry>
    );
}
