import { motion, useReducedMotion } from "motion/react";

/**
 * Heart-count chip shown on the card. The number pops when it changes so an
 * optimistic heart reads as landed; reduced motion renders it flat.
 */
export function HeartCount({ likes, className }: { likes: number; className?: string }) {
    const reduceMotion = useReducedMotion() === true;

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-sm font-semibold text-white backdrop-blur-sm ${className ?? ""}`}
        >
            <span aria-hidden="true" className="text-heart">
                ♥
            </span>
            <motion.span
                key={likes}
                initial={reduceMotion ? false : { scale: 1.3 }}
                animate={{ scale: 1 }}
                transition={
                    reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 20 }
                }
                className="tabular-nums"
            >
                {likes}
            </motion.span>
            <span className="sr-only">{likes === 1 ? "heart" : "hearts"}</span>
        </span>
    );
}
