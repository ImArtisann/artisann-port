/** @jsxImportSource react */
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { portfolioApiEndpoints, photoAtom } from "@/lib/rpc-client";
import type { Photo, PhotoTag } from "@artisann-port/presence/photos";
import { CardContent } from "@artisann-port/ui/components/card";
import { cn } from "@artisann-port/ui/lib/utils";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from "@artisann-port/ui/components/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import {
    ChevronLeftIcon,
    ChevronRightIcon,
    ImagesIcon,
    ImageNotFound01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type KeyboardEvent,
} from "react";

/**
 * Where the gallery lives on the page. The life sidebar exists twice (desktop and mobile
 * variants of the same section); cats live in the bento card.
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

function PhotoDeck({
    photos,
    position,
    photoNoun,
    advance,
}: {
    photos: readonly Photo[];
    position: number;
    photoNoun: string;
    advance: () => void;
}) {
    const x = useMotionValue(0);
    const rotate = useTransform(x, [-200, 200], [-15, 15]);
    const reduceMotion = useReducedMotion();
    const busy = useRef(false);
    const [exiting, setExiting] = useState(false);
    const mounted = useRef(true);
    const generation = useRef(0);
    const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(() => new Set());
    const canSwipe = photos.length > 1;
    const selectedKey = photos[position]?.key;

    useLayoutEffect(() => {
        generation.current += 1;
        x.stop();
        x.set(0);
        busy.current = false;
        setExiting(false);
        setFailedKeys(new Set());
    }, [selectedKey, photos, x]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            x.stop();
        };
    }, [x]);

    // oxlint-disable-next-line effecttsgo/async-function
    const shuffle = async (direction: number) => {
        if (!canSwipe || busy.current) return;
        busy.current = true;
        setExiting(true);
        const currentGeneration = generation.current;
        if (!reduceMotion) {
            await animate(x, direction * 400, { type: "spring", stiffness: 400, damping: 40 });
        }
        if (mounted.current && generation.current === currentGeneration) advance();
    };

    return (
        <div
            tabIndex={0}
            role="group"
            aria-label="Swipe or use the left and right arrow keys to browse photos"
            className="relative size-full min-h-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
            {Array.from({ length: Math.min(2, photos.length) }, (_, offset) => {
                const index = (position + offset) % photos.length;
                const photo = photos[index]!;
                const top = offset === 0;
                return (
                    <motion.div
                        key={photo.key}
                        aria-hidden={!top}
                        initial={false}
                        className={cn(
                            "absolute inset-0 flex items-center justify-center overflow-hidden rounded-xl bg-muted",
                            top && canSwipe && "cursor-grab touch-pan-y active:cursor-grabbing",
                            offset > 0 && "pointer-events-none",
                        )}
                        style={{
                            zIndex: 3 - offset,
                            x: top ? x : 0,
                            rotate: top && !reduceMotion ? rotate : 0,
                            willChange: top && canSwipe ? "transform" : undefined,
                        }}
                        drag={top && canSwipe && !exiting ? "x" : false}
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={reduceMotion ? 0 : 0.7}
                        dragMomentum={false}
                        onDragStart={() => {
                            x.stop();
                        }}
                        onDragEnd={(_, info) => {
                            if (Math.abs(info.offset.x) > 80 || Math.abs(info.velocity.x) > 400) {
                                const direction = Math.sign(
                                    Math.abs(info.offset.x) > 80 ? info.offset.x : info.velocity.x,
                                );
                                void shuffle(direction);
                            } else {
                                void animate(x, 0, { type: "spring", stiffness: 600, damping: 30 });
                            }
                        }}
                    >
                        {failedKeys.has(photo.key) ? (
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
                        ) : (
                            <img
                                src={photo.url}
                                alt={top ? `${photoNoun} ${index + 1} of ${photos.length}` : ""}
                                loading="lazy"
                                decoding="async"
                                draggable={false}
                                onError={() =>
                                    setFailedKeys((previous) => new Set(previous).add(photo.key))
                                }
                                className="size-full rounded-xl object-cover select-none"
                            />
                        )}
                    </motion.div>
                );
            })}
        </div>
    );
}

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

    // Atom refreshes are data lifecycle work; synchronize only local presentation state during
    // render. The aggregate returns a new array for each successful walk, including unchanged keys.
    if (isSuccessful && selection.priorOrdering !== photos) {
        setSelection({
            selectedKey: selectPhotoKey(selection.priorOrdering, selection.selectedKey, photos),
            priorOrdering: photos,
        });
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
        }
    };
    const onGalleryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
        }
    };

    const frame =
        "relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
    const sidebarSize =
        layout === "sidebar-desktop"
            ? "h-85 max-h-110 flex-none gap-2 max-lg:hidden"
            : "aspect-4/5 max-h-110 flex-none gap-2 lg:hidden";
    const alt =
        current === undefined ? copy.label : `${copy.photoNoun} ${position + 1} of ${count}`;

    const activeImage =
        current === undefined ? null : (
            <PhotoDeck
                photos={photos}
                position={position}
                photoNoun={copy.photoNoun}
                advance={() => step(1)}
            />
        );

    const unavailable = isStale || (AsyncResult.isFailure(result) && value._tag === "None");
    const controls = count > 0 && (
        <div className="flex shrink-0 items-center justify-end gap-1 pt-1">
            <button
                type="button"
                aria-label={`Previous ${copy.photoNoun.toLowerCase()}`}
                disabled={count < 2}
                onClick={() => step(-1)}
                className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
            >
                <HugeiconsIcon icon={ChevronLeftIcon} size={20} aria-hidden="true" />
            </button>
            <button
                type="button"
                aria-label={`Next ${copy.photoNoun.toLowerCase()}`}
                disabled={count < 2}
                onClick={() => step(1)}
                className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
            >
                <HugeiconsIcon icon={ChevronRightIcon} size={20} aria-hidden="true" />
            </button>
        </div>
    );

    if (layout === "card") {
        return (
            <CardContent
                {...rest}
                onKeyDown={onGalleryKeyDown}
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
                            {unavailable ? "Cat photos are temporarily unavailable." : copy.empty}
                        </EmptyDescription>
                    </Empty>
                ) : (
                    <div
                        role="group"
                        aria-label="Cat photo carousel, use the left and right arrow keys to browse"
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
                {controls}
                <p role="status" aria-live="polite" className="sr-only">
                    {current === undefined ? "" : `${alt}. `}
                    {unavailable ? "Photo updates are temporarily unavailable." : ""}
                </p>
            </CardContent>
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
            role="group"
            aria-label="Life photo carousel, use the left and right arrow keys to browse"
            onKeyDown={onGalleryKeyDown}
            {...rest}
            className={cn(
                "flex min-w-0 flex-none flex-col",
                layout === "sidebar-desktop" ? "max-lg:hidden" : "lg:hidden",
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
            {controls}
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
