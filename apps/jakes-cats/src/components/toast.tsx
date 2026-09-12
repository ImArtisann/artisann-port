import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";

/** Auto-dismiss delay for a refusal message. */
const TOAST_MS = 3_200;

/** Refusal notice — a rate limit or a failed heart — dismissed on its own. */
export function Toast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
    const reduceMotion = useReducedMotion() === true;

    useEffect(() => {
        if (message === null) return;
        const timer = window.setTimeout(onDismiss, TOAST_MS);
        return () => window.clearTimeout(timer);
    }, [message, onDismiss]);

    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
            <AnimatePresence>
                {message !== null && (
                    <motion.p
                        key={message}
                        role="status"
                        aria-live="polite"
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                        transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
                        className="bg-ink text-cream rounded-full px-4 py-2 text-sm font-medium shadow-lg"
                    >
                        {message}
                    </motion.p>
                )}
            </AnimatePresence>
        </div>
    );
}
