import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { ActionBar } from "../components/action-bar.tsx";
import { CatDeck, DeckSkeleton, type DeckHandle } from "../components/cat-deck.tsx";
import { Toast } from "../components/toast.tsx";
import { useDeck } from "../components/use-deck.ts";
import { getDeck } from "../server-fns.ts";

export const Route = createFileRoute("/")({
    loader: () => getDeck(),
    component: Home,
    pendingComponent: Pending,
    errorComponent: Failed,
});

/** Card stage and one action row; the wordmark and nav live in the root route. */
function Frame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
    return (
        <main className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6">
            <section aria-label="Cat photo deck" className="flex items-start justify-center pt-2">
                {children}
            </section>
            <div className="flex h-16 shrink-0 items-center justify-center">{footer}</div>
        </main>
    );
}

/** Plain text panel for the empty and error states. No icons. */
function DeckPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
    return (
        <div className="border-line bg-card flex w-full max-w-md flex-col items-center gap-3 rounded-3xl border px-6 py-10 text-center">
            <h2 className="font-display text-ink text-xl font-bold">{title}</h2>
            <p className="text-pass text-sm">{body}</p>
            {action}
        </div>
    );
}

function Home() {
    const data = Route.useLoaderData();
    const deck = useDeck(data.photos);
    const deckRef = useRef<DeckHandle>(null);
    const current = deck.current;

    // Keyboard drives the same exit animation as a drag: ← skips, → or Enter hearts.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                target.closest("button, a, input, select, textarea") !== null
            ) {
                return;
            }
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                deckRef.current?.swipe("left");
            } else if (event.key === "ArrowRight" || event.key === "Enter") {
                event.preventDefault();
                deckRef.current?.swipe("right");
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    return (
        <Frame
            footer={
                current === undefined ? null : (
                    <ActionBar
                        hearted={current.hearted}
                        onSkip={() => deckRef.current?.swipe("left")}
                        onHeart={() => deckRef.current?.swipe("right")}
                    />
                )
            }
        >
            {current === undefined ? (
                <DeckPanel title="No cats yet." body="Jake is on it. Check back soon." />
            ) : (
                <CatDeck
                    ref={deckRef}
                    current={current}
                    next={deck.next}
                    onResolve={deck.resolve}
                />
            )}
            <p aria-live="polite" className="sr-only">
                {deck.announcement}
            </p>
            <Toast message={deck.toast} onDismiss={deck.dismissToast} />
        </Frame>
    );
}

function Pending() {
    return (
        <Frame>
            <DeckSkeleton />
        </Frame>
    );
}

function Failed({ reset }: { reset: () => void }) {
    return (
        <Frame>
            <DeckPanel
                title="Cats are napping"
                body="Try again in a moment."
                action={
                    <button
                        type="button"
                        onClick={reset}
                        className="bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream mt-1 rounded-full px-5 py-2.5 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                        Try again
                    </button>
                }
            />
        </Frame>
    );
}
