import { photoAtom, portfolioApiEndpoints } from "@/lib/rpc-client";
import type { Photo, PhotoTag } from "@artisann-port/presence/photos";
import { cn } from "@artisann-port/ui/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageNotFound01Icon } from "@hugeicons-pro/core-solid-rounded";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
    animate,
    motion,
    useInView,
    useMotionValue,
    useReducedMotion,
    useTransform,
} from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    AUTO_ADVANCE_MS,
    DRAG_ELASTIC,
    DRAG_ROTATE_DEG,
    DRAG_ROTATE_RANGE_PX,
    EXIT_DISTANCE_PX,
    EXIT_SPRING,
    SNAP_BACK_SPRING,
    SWIPE_OFFSET_PX,
    SWIPE_VELOCITY_PX_S,
    USER_PAUSE_MS,
} from "./gallery-config.ts";

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

/**
 * Photos plus the local selection for one gallery placement. Each gallery owns its
 * selection; only the fetched list comes from the shared atom.
 */
export function useGallerySelection(
    tag: PhotoTag,
    endpoint: string = portfolioApiEndpoints.rpcUrl,
) {
    const result = useAtomValue(photoAtom(tag, endpoint));
    const value = AsyncResult.value(result);
    const photos = value._tag === "Some" ? value.value : [];
    const isSuccessful = AsyncResult.isSuccess(result);
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

    const position = Math.max(
        0,
        photos.findIndex((photo) => photo.key === selection.selectedKey),
    );

    // The next key is resolved inside the updater so step keeps a stable identity: the deck's
    // auto-advance timer must not re-arm on navigation or on atom refreshes that return a new
    // array for unchanged keys.
    const step = useCallback((delta: number) => {
        setSelection((previous) => {
            const ordering = previous.priorOrdering;
            if (ordering.length === 0) return previous;
            const index = Math.max(
                0,
                ordering.findIndex((photo) => photo.key === previous.selectedKey),
            );
            const next = ordering[(index + delta + ordering.length) % ordering.length];
            return next === undefined || next.key === previous.selectedKey
                ? previous
                : { ...previous, selectedKey: next.key };
        });
    }, []);

    return {
        photos,
        position,
        current: photos[position],
        unavailable: AsyncResult.isFailure(result),
        step,
    };
}

/**
 * The swipeable card stack shared by every photo gallery. Only the top card is
 * interactive; the card behind it previews whichever neighbour the current drag
 * direction would reveal.
 */
export function PhotoDeck({
    photos,
    position,
    photoNoun,
    navigate,
}: {
    photos: readonly Photo[];
    position: number;
    photoNoun: string;
    navigate: (delta: 1 | -1) => void;
}) {
    const x = useMotionValue(0);
    const rotate = useTransform(
        x,
        [-DRAG_ROTATE_RANGE_PX, DRAG_ROTATE_RANGE_PX],
        [-DRAG_ROTATE_DEG, DRAG_ROTATE_DEG],
    );
    const reduceMotion = useReducedMotion();
    const busy = useRef(false);
    const dragging = useRef(false);
    const deckRef = useRef<HTMLDivElement | null>(null);
    const inView = useInView(deckRef, { amount: 0.1 });
    const [exiting, setExiting] = useState(false);
    const mounted = useRef(true);
    const generation = useRef(0);
    const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(() => new Set());
    // Which neighbour the drag reveals: rightward reveals the previous photo,
    // leftward the next. Must return to 1 whenever no drag is in progress —
    // a stale value makes the next exit reveal the wrong card before the
    // committed index lands.
    const [peek, setPeek] = useState<1 | -1>(1);
    const canSwipe = photos.length > 1;
    const selectedKey = photos[position]?.key;
    // Timestamp until which a user swipe suspends the automatic rotation. pauseNonce
    // re-arms the timer so the pause is honoured even mid-cycle.
    const pausedUntil = useRef(0);
    const [pauseNonce, setPauseNonce] = useState(0);
    const pauseAutoAdvance = useCallback(() => {
        pausedUntil.current = performance.now() + USER_PAUSE_MS;
        setPauseNonce((nonce) => nonce + 1);
    }, []);

    useLayoutEffect(() => {
        generation.current += 1;
        x.stop();
        x.set(0);
        busy.current = false;
        setExiting(false);
        setPeek(1);
    }, [selectedKey, x]);

    // Prune failure markers for photos that no longer exist instead of clearing
    // them on every refresh: a refreshed array must not re-request a known-bad
    // image, and must not advance the generation of an in-flight shuffle.
    useEffect(() => {
        const available = new Set(photos.map((photo) => photo.key));
        setFailedKeys((previous) => {
            const next = new Set([...previous].filter((key) => available.has(key)));
            return next.size === previous.size ? previous : next;
        });
    }, [photos]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            x.stop();
        };
    }, [x]);

    const shuffle = useCallback(
        // oxlint-disable-next-line effecttsgo/async-function
        async (direction: number) => {
            if (!canSwipe || busy.current) return;
            busy.current = true;
            setExiting(true);
            setPeek(direction > 0 ? -1 : 1);
            const currentGeneration = generation.current;
            if (!reduceMotion) {
                await animate(x, direction * EXIT_DISTANCE_PX, EXIT_SPRING);
            }
            if (mounted.current && generation.current === currentGeneration) {
                // Reset before navigate: the promoted card binds this motion value when it
                // becomes top, and Motion flushes style writes on the frame loop — a stale
                // offset would paint for one frame before a layout-effect reset lands.
                x.set(0);
                navigate(direction > 0 ? -1 : 1);
            }
        },
        [canSwipe, navigate, reduceMotion, x],
    );

    // The cycling animation is the same spring the deck uses for a left swipe, so it runs only
    // once part of the deck scrolls into view. A finger already on the card or an in-flight
    // shuffle suppresses the tick, and a committed swipe pauses the cycle for USER_PAUSE_MS.
    useEffect(() => {
        if (reduceMotion || !canSwipe || !inView) return;
        let timer = 0;
        const arm = (delay: number) => {
            timer = window.setTimeout(() => {
                const remaining = pausedUntil.current - performance.now();
                if (remaining > 0) {
                    arm(remaining);
                    return;
                }
                if (!dragging.current && !busy.current) void shuffle(-1);
                arm(AUTO_ADVANCE_MS);
            }, delay);
        };
        arm(Math.max(AUTO_ADVANCE_MS, pausedUntil.current - performance.now()));
        return () => window.clearTimeout(timer);
    }, [canSwipe, inView, pauseNonce, reduceMotion, shuffle]);

    return (
        <div ref={deckRef} className="relative size-full min-h-0 rounded-xl">
            {Array.from({ length: Math.min(2, photos.length) }, (_, offset) => {
                const step = offset === 0 ? 0 : peek;
                const index = (position + step + photos.length) % photos.length;
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
                        dragElastic={reduceMotion ? 0 : DRAG_ELASTIC}
                        dragMomentum={false}
                        onDragStart={() => {
                            dragging.current = true;
                            x.stop();
                        }}
                        onDrag={() => {
                            const next = x.get() >= 0 ? -1 : 1;
                            if (next !== peek) setPeek(next);
                        }}
                        onDragEnd={(_, info) => {
                            dragging.current = false;
                            const committed =
                                Math.abs(info.offset.x) > SWIPE_OFFSET_PX ||
                                Math.abs(info.velocity.x) > SWIPE_VELOCITY_PX_S;
                            if (committed && !busy.current) {
                                pauseAutoAdvance();
                                const direction = Math.sign(
                                    Math.abs(info.offset.x) > SWIPE_OFFSET_PX
                                        ? info.offset.x
                                        : info.velocity.x,
                                );
                                void shuffle(direction);
                            } else {
                                // Canceled drag — or a swipe that landed while an exit was
                                // already in flight — returns to center and restores the
                                // default forward peek.
                                setPeek(1);
                                void animate(x, 0, SNAP_BACK_SPRING);
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
