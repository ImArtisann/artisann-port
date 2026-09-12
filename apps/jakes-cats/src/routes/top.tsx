import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { photoIdFromKey } from "../contracts.ts";
import { getLeaderboard } from "../server-fns.ts";

export const Route = createFileRoute("/top")({
    loader: () => getLeaderboard(),
    component: TopCats,
    pendingComponent: Pending,
    errorComponent: Failed,
    head: () => ({
        meta: [{ title: "Top cats · Jake's Cats" }],
    }),
});

/** The most-hearted photos, ranked. Every row opens that cat's page. */
function TopCats() {
    const { entries } = Route.useLoaderData();

    return (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6">
            <h1 className="font-display text-ink text-2xl font-bold tracking-tight">Top cats</h1>
            {entries.length === 0 ? (
                <p className="text-pass text-sm">
                    No hearts yet —{" "}
                    <Link to="/" className="text-ink underline underline-offset-4">
                        go swipe
                    </Link>
                    .
                </p>
            ) : (
                <ol className="flex flex-col gap-2">
                    {entries.map((entry) => {
                        const id = photoIdFromKey(entry.photo.key);
                        if (id === null) return null;
                        return (
                            <li key={entry.photo.key}>
                                <Link
                                    to="/photos/$id"
                                    params={{ id }}
                                    className="border-line bg-card hover:border-pass focus-visible:ring-ink flex items-center gap-3 rounded-2xl border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
                                >
                                    <span className="text-pass w-6 shrink-0 text-right text-sm font-semibold tabular-nums">
                                        {entry.rank}
                                    </span>
                                    <img
                                        src={entry.photo.url}
                                        alt="A cat"
                                        width={96}
                                        height={96}
                                        loading="lazy"
                                        decoding="async"
                                        className="size-24 shrink-0 rounded-xl object-cover"
                                    />
                                    <span className="text-ink text-sm font-semibold tabular-nums">
                                        ♥ {entry.photo.likes}
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ol>
            )}
        </main>
    );
}

function Pending() {
    return (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6">
            <h1 className="font-display text-ink text-2xl font-bold tracking-tight">Top cats</h1>
            <p className="text-pass text-sm">Counting hearts…</p>
        </main>
    );
}

/** Safe, fixed copy — the loader's error is not rendered. */
function Failed() {
    const router = useRouter();
    return (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6">
            <h1 className="font-display text-ink text-2xl font-bold tracking-tight">Top cats</h1>
            <p className="text-pass text-sm">The leaderboard is napping. Try again in a moment.</p>
            <button
                type="button"
                // Invalidation reruns the getLeaderboard loader; the router owns the
                // pending and repeat-failure states, and a fresh match resets this
                // error boundary.
                onClick={() => void router.invalidate()}
                className="bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream self-start rounded-full px-5 py-2.5 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
            >
                Try again
            </button>
        </main>
    );
}
