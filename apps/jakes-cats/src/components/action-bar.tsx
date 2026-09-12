import { motion, useReducedMotion } from "motion/react";
import { HeartButton } from "./heart-button.tsx";

/**
 * Skip and Heart. Both buttons drive the deck's own exit animation through the
 * callbacks, so a tap and a drag commit identically. The heart is disabled once
 * the photo is hearted on the server, which makes a second heart impossible.
 */
export function ActionBar({
    onSkip,
    onHeart,
    hearted,
}: {
    onSkip: () => void;
    onHeart: () => void;
    hearted: boolean;
}) {
    const reduceMotion = useReducedMotion() === true;
    const press = reduceMotion ? undefined : { scale: 0.92 };

    return (
        <div className="flex items-center justify-center gap-6">
            <motion.button
                type="button"
                onClick={onSkip}
                whileTap={press}
                aria-label="Skip this cat"
                className="border-line bg-card text-pass hover:border-pass focus-visible:ring-ink focus-visible:ring-offset-cream flex size-14 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="size-6"
                >
                    <path d="M5 6l6 6-6 6" />
                    <path d="M13 6l6 6-6 6" />
                </svg>
            </motion.button>
            <HeartButton hearted={hearted} onHeart={onHeart} />
        </div>
    );
}
