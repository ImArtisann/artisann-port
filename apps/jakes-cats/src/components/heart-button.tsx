import { motion, useReducedMotion } from "motion/react";

/**
 * The one heart button, shared by the deck action bar and the photo page.
 * Filled and disabled once the photo is hearted — a second heart is impossible
 * from the UI — with a "Hearted" caption underneath. Press scale only; the
 * burst ring is gone, and reduced motion presses flat.
 */
export function HeartButton({ hearted, onHeart }: { hearted: boolean; onHeart: () => void }) {
    const reduceMotion = useReducedMotion() === true;
    const press = reduceMotion ? undefined : { scale: 0.92 };

    return (
        <span className="relative inline-flex">
            <motion.button
                type="button"
                onClick={onHeart}
                whileTap={hearted ? undefined : press}
                disabled={hearted}
                aria-label={hearted ? "Hearted" : "Heart this cat"}
                className="bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream flex size-14 items-center justify-center rounded-full text-white shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill={hearted ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="size-6"
                >
                    <path d="M12 20.5S3.5 15 3.5 9.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.6c0 5.4-8.5 10.9-8.5 10.9Z" />
                </svg>
            </motion.button>
            {hearted && (
                <span className="text-pass absolute top-full left-1/2 mt-1 -translate-x-1/2 text-xs whitespace-nowrap">
                    Hearted
                </span>
            )}
        </span>
    );
}
