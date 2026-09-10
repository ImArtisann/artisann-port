/** @jsxImportSource react */
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { portfolioApiEndpoints, photoAtom } from "@/lib/rpc-client";
import type { Photo, PhotoTag } from "@artisann-port/presence/photos";
import { Button } from "@artisann-port/ui/components/button";
import { CardContent, CardFooter } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from "@artisann-port/ui/components/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import {
    ArrowLeft01Icon,
    ArrowRight01Icon,
    ImagesIcon,
    ImageNotFound01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react";
import { useState, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";

/**
 * Where the gallery lives on the page. The life sidebar exists twice (desktop and mobile
 * variants of the same section); the cats card owns its footer controls.
 */
export type PhotoGalleryLayout = "sidebar-desktop" | "sidebar-mobile" | "card";

const COPY = {
    "sidebar-desktop": {
        label: "Life photos",
        empty: "A few moments from my life",
        photoNoun: "Life photo",
    },
    "sidebar-mobile": {
        label: "Life photos",
        empty: "A few moments from my life",
        photoNoun: "Life photo",
    },
    card: { label: "Cat photos", empty: "Cat photos go here", photoNoun: "Cat photo" },
} satisfies Record<PhotoGalleryLayout, { label: string; empty: string; photoNoun: string }>;

type PhotoGalleryProps = {
    tag: PhotoTag;
    layout: PhotoGalleryLayout;
    /** Public RPC endpoint; defaults to the production Worker route. */
    endpoint?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "children">;

type GallerySelection = {
    /** Selection belongs to this gallery placement, not the shared atom. */
    readonly selectedKey: string | null;
    /** Last successful ordering, used to select a successor after deletion. */
    readonly priorOrdering: readonly Photo[];
};

/** Preserve selection, then choose the first surviving successor, then newest. */
const selectPhotoKey = (
    priorOrdering: readonly Photo[],
    selectedKey: string | null,
    photos: readonly Photo[],
): string | null => {
    const availableKeys = new Set(photos.map((photo) => photo.key));
    if (selectedKey !== null && availableKeys.has(selectedKey)) return selectedKey;

    const selectedIndex = priorOrdering.findIndex((photo) => photo.key === selectedKey);
    if (selectedIndex >= 0) {
        const successor = priorOrdering
            .slice(selectedIndex + 1)
            .find((photo) => availableKeys.has(photo.key));
        if (successor !== undefined) return successor.key;
    }
    return photos[0]?.key ?? null;
};

function PhotoGalleryInner({
    tag,
    layout,
    endpoint = portfolioApiEndpoints.rpcUrl,
    ...rest
}: PhotoGalleryProps) {
    const copy = COPY[layout];
    const result = useAtomValue(photoAtom(tag, endpoint));
    const value = AsyncResult.value(result);
    const photos = value._tag === "Some" ? value.value : [];
    const isSuccessful = AsyncResult.isSuccess(result);
    const isStale = AsyncResult.isFailure(result) && value._tag === "Some";
    const [selection, setSelection] = useState<GallerySelection>({
        selectedKey: null,
        priorOrdering: [],
    });
    const [failedKey, setFailedKey] = useState<string | null>(null);

    // Atom refreshes are data lifecycle work; synchronize only local presentation state during
    // render. The aggregate returns a new array for each successful walk, including unchanged
    // keys, so a later success also clears a temporary broken-image marker.
    if (isSuccessful && selection.priorOrdering !== photos) {
        setSelection({
            selectedKey: selectPhotoKey(selection.priorOrdering, selection.selectedKey, photos),
            priorOrdering: photos,
        });
        if (failedKey !== null) setFailedKey(null);
    }

    const selectedKey = selection.selectedKey;
    const position = Math.max(
        0,
        photos.findIndex((photo) => photo.key === selectedKey),
    );
    const current = photos[position];
    const count = photos.length;
    const step = (delta: number) => {
        if (count === 0) return;
        const next = photos[(position + delta + count) % count];
        if (next !== undefined) {
            setSelection((previous) => ({ ...previous, selectedKey: next.key }));
            setFailedKey(null);
        }
    };
    const onGalleryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
        }
    };

    const frame =
        "relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl bg-muted outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
    const sidebarSize =
        layout === "sidebar-desktop"
            ? "h-85 max-h-110 flex-none gap-2 p-4 max-lg:hidden"
            : "aspect-4/5 max-h-110 flex-none gap-2 p-4 lg:hidden";
    const alt =
        current === undefined ? copy.label : `${copy.photoNoun} ${position + 1} of ${count}`;

    const failed = current !== undefined && failedKey === current.key;
    const activeImage =
        current === undefined || failed ? null : (
            <img
                key={current.key}
                src={current.url}
                alt={alt}
                loading="lazy"
                decoding="async"
                onError={() => setFailedKey(current.key)}
                className="size-full object-contain"
            />
        );

    const unavailable = isStale || (AsyncResult.isFailure(result) && value._tag === "None");

    if (layout === "card") {
        return (
            <>
                <CardContent {...rest}>
                    {count === 0 ? (
                        <Empty
                            className="aspect-4/5 max-h-110 flex-none gap-3"
                            role={unavailable ? "status" : undefined}
                        >
                            <EmptyMedia>
                                <HugeiconsIcon icon={ImagesIcon} size={32} aria-hidden="true" />
                            </EmptyMedia>
                            <EmptyDescription>
                                {unavailable
                                    ? "Cat photos are temporarily unavailable."
                                    : copy.empty}
                            </EmptyDescription>
                        </Empty>
                    ) : (
                        <div
                            tabIndex={0}
                            role="group"
                            aria-label="Cat photo carousel, use the left and right arrow keys to browse"
                            onKeyDown={onGalleryKeyDown}
                            className={`${frame} aspect-4/5 max-h-110 flex-none`}
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
                </CardContent>
                <CardFooter className="justify-between gap-3">
                    <p className="sr-only">A slideshow of my cats</p>
                    {count > 0 ? (
                        <span
                            className="shrink-0 text-image-caption whitespace-nowrap text-muted-foreground tabular-nums"
                            aria-hidden="true"
                        >
                            {position + 1} / {count}
                        </span>
                    ) : (
                        <span aria-hidden="true" />
                    )}
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
                    <div className="flex items-center gap-1 lg:gap-3">
                        <Button
                            variant="ghost"
                            size="icon-gallery"
                            disabled={count < 2}
                            aria-label="Previous cat photo"
                            className="text-muted-foreground"
                            onClick={() => step(-1)}
                        >
                            <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-gallery"
                            disabled={count < 2}
                            aria-label="Next cat photo"
                            className="text-muted-foreground"
                            onClick={() => step(1)}
                        >
                            <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
                        </Button>
                    </div>
                </CardFooter>
            </>
        );
    }

    // Keep the existing empty treatment and frame size; populated galleries expose
    // touch controls as well as keyboard navigation.
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
                    <EmptyDescription
                        className={layout === "sidebar-desktop" ? "text-aside" : undefined}
                    >
                        {unavailable ? "Life photos are temporarily unavailable." : copy.empty}
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div
            tabIndex={0}
            role="group"
            aria-label="Life photo carousel, use the left and right arrow keys to browse"
            onKeyDown={onGalleryKeyDown}
            {...rest}
            className={`${rest.className !== undefined ? `${rest.className} ` : ""}${frame} ${sidebarSize} flex-col`}
        >
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                {activeImage ?? (
                    <div className="flex flex-col items-center gap-2">
                        <HugeiconsIcon icon={ImageNotFound01Icon} size={26} aria-hidden="true" />
                        <p className="text-image-caption text-muted-foreground">
                            Photo unavailable
                        </p>
                    </div>
                )}
            </div>
            <div className="flex min-h-11 w-full shrink-0 items-center justify-between gap-2">
                <span
                    className="text-image-caption text-muted-foreground tabular-nums"
                    aria-hidden="true"
                >
                    {position + 1} / {count}
                </span>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon-gallery"
                        disabled={count < 2}
                        aria-label="Previous life photo"
                        className="size-11 lg:size-11"
                        onClick={() => step(-1)}
                    >
                        <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-gallery"
                        disabled={count < 2}
                        aria-label="Next life photo"
                        className="size-11 lg:size-11"
                        onClick={() => step(1)}
                    >
                        <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
                    </Button>
                </div>
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

export function PhotoGallery(props: PhotoGalleryProps) {
    return (
        <SharedAtomRegistry>
            <PhotoGalleryInner {...props} />
        </SharedAtomRegistry>
    );
}
