import { useCallback, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Link } from "@tanstack/react-router";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { photoIdFromKey, type DeckPhoto } from "../contracts.ts";
import { HeartCount } from "./heart-count.tsx";
import {
    DRAG_ELASTIC,
    DRAG_ROTATE_DEG,
    DRAG_ROTATE_RANGE_PX,
    EXIT_DISTANCE_PX,
    EXIT_SPRING,
    SNAP_BACK_SPRING,
    STAMP_ROTATE_DEG,
    SWIPE_OFFSET_PX,
    commitDirection,
    type SwipeDirection,
} from "./deck-config.ts";

/** Imperative deck control: buttons and the keyboard share the drag exit animation. */
export type DeckHandle = {
    swipe: (direction: SwipeDirection) => void;
};

/** One card face: the photo, or a plain tile when the image itself fails to load. */
function CardFace({
    photo,
    eager,
    failed,
    onError,
}: {
    photo: DeckPhoto;
    eager: boolean;
    failed: boolean;
    onError: () => void;
}) {
    if (failed) {
        return (
            <div className="bg-card text-pass flex size-full items-center justify-center">
                <p className="text-sm">Photo unavailable</p>
            </div>
        );
    }

    return (
        <img
            src={photo.url}
            alt="A cat"
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            draggable={false}
            onError={onError}
            className="size-full object-cover select-none"
        />
    );
}

/**
 * The swipe stack: the top card follows the finger on x and rotates with it, the
 * next card waits behind at 95%. A right swipe hearts, a left swipe skips — both
 * commit through the same spring exit. `swipe` is exposed on the ref so the
 * action bar and the keyboard drive that identical animation.
 */
export function CatDeck({
    current,
    next,
    onResolve,
    ref,
}: {
    current: DeckPhoto;
    next: DeckPhoto | undefined;
    onResolve: (direction: SwipeDirection) => void;
    ref?: Ref<DeckHandle>;
}) {
    const x = useMotionValue(0);
    const reduceMotion = useReducedMotion() === true;
    const rotate = useTransform(
        x,
        [-DRAG_ROTATE_RANGE_PX, DRAG_ROTATE_RANGE_PX],
        [-DRAG_ROTATE_DEG, DRAG_ROTATE_DEG],
    );
    // Stamps fade in over the drag distance that commits a swipe.
    const likeOpacity = useTransform(x, [0, SWIPE_OFFSET_PX], [0, 1]);
    const skipOpacity = useTransform(x, [-SWIPE_OFFSET_PX, 0], [1, 0]);
    const busy = useRef(false);
    const [exiting, setExiting] = useState(false);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    const photoId = photoIdFromKey(current.key);

    const markFailed = useCallback((key: string) => {
        setFailed((previous) => new Set(previous).add(key));
    }, []);

    const swipe = useCallback(
        (direction: SwipeDirection) => {
            if (busy.current) return;
            busy.current = true;
            setExiting(true);
            const target = (direction === "right" ? 1 : -1) * EXIT_DISTANCE_PX;
            const land = () => {
                busy.current = false;
                setExiting(false);
                // Reset before the promoted card binds this motion value: the deck
                // re-renders with the next photo at rest, never mid-exit.
                x.set(0);
                onResolve(direction);
            };
            if (reduceMotion) {
                x.set(target);
                land();
                return;
            }
            void animate(x, target, EXIT_SPRING).then(land);
        },
        [onResolve, reduceMotion, x],
    );

    useImperativeHandle(ref, () => ({ swipe }), [swipe]);

    const topFailed = failed.has(current.key);

    return (
        <div
            role="group"
            aria-label="Cat photo deck"
            className="relative aspect-4/5 max-h-full w-full max-w-md"
        >
            {next !== undefined && (
                <div
                    aria-hidden="true"
                    className="border-line bg-card absolute inset-0 scale-95 overflow-hidden rounded-3xl border"
                >
                    <CardFace
                        photo={next}
                        eager={false}
                        failed={failed.has(next.key)}
                        onError={() => markFailed(next.key)}
                    />
                </div>
            )}
            <motion.div
                key={current.key}
                className="border-line bg-card absolute inset-0 cursor-grab touch-pan-y overflow-hidden rounded-3xl border shadow-xl active:cursor-grabbing"
                style={{ x, rotate: reduceMotion ? 0 : rotate, willChange: "transform" }}
                drag={exiting ? false : "x"}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={reduceMotion ? 0 : DRAG_ELASTIC}
                dragMomentum={false}
                onDragStart={() => x.stop()}
                onDragEnd={(_, info) => {
                    const direction = commitDirection(info.offset.x, info.velocity.x);
                    if (direction === null) {
                        void animate(x, 0, SNAP_BACK_SPRING);
                        return;
                    }
                    swipe(direction);
                }}
            >
                <CardFace
                    photo={current}
                    eager
                    failed={topFailed}
                    onError={() => markFailed(current.key)}
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-linear-to-t from-black/60 to-transparent" />
                <div className="pointer-events-none absolute bottom-3 left-3">
                    <HeartCount likes={current.likes} />
                </div>
                {photoId !== null && (
                    <Link
                        to="/photos/$id"
                        params={{ id: photoId }}
                        // Capture-stop so a tap on the link never becomes a card drag.
                        onPointerDownCapture={(event) => event.stopPropagation()}
                        className="bg-card/90 text-ink focus-visible:ring-heart absolute right-3 bottom-3 rounded-full px-3 py-1 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
                    >
                        Comments
                    </Link>
                )}
                <motion.span
                    aria-hidden="true"
                    style={{ opacity: likeOpacity, rotate: STAMP_ROTATE_DEG }}
                    className="border-heart text-heart pointer-events-none absolute top-5 left-4 rounded-lg border-4 px-3 py-1 text-4xl font-black tracking-widest uppercase"
                >
                    LIKE
                </motion.span>
                <motion.span
                    aria-hidden="true"
                    style={{ opacity: skipOpacity, rotate: -STAMP_ROTATE_DEG }}
                    className="border-pass text-pass pointer-events-none absolute top-5 right-4 rounded-lg border-4 px-3 py-1 text-4xl font-black tracking-widest uppercase"
                >
                    SKIP
                </motion.span>
            </motion.div>
        </div>
    );
}

/** Loading placeholder with the footprint of a card. */
export function DeckSkeleton() {
    return (
        <div
            aria-hidden="true"
            className="border-line bg-card animate-pulse motion-reduce:animate-none relative aspect-4/5 max-h-full w-full max-w-md rounded-3xl border"
        />
    );
}
