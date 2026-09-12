import { Link } from "@tanstack/react-router";
import { SITE_MARK_URL } from "../contracts.ts";

/**
 * The shared site chrome: the pixel-cat mark links home, plus a small nav.
 * No wordmark, no tagline — the deck is the personality.
 */
export function SiteHeader() {
    return (
        <header className="mx-auto flex w-full max-w-lg shrink-0 items-center justify-between px-4 pt-4">
            <Link
                to="/"
                aria-label="Jake's Cats — home"
                className="focus-visible:ring-ink flex items-center rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
            >
                <img
                    src={SITE_MARK_URL}
                    alt=""
                    className="size-7 rounded-md"
                    style={{ imageRendering: "pixelated" }}
                />
            </Link>
            <nav aria-label="Site" className="flex items-center gap-4 text-sm font-medium">
                <Link
                    to="/"
                    activeOptions={{ exact: true }}
                    className="text-pass hover:text-ink focus-visible:ring-ink rounded-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                    activeProps={{ className: "text-ink underline underline-offset-4" }}
                >
                    Deck
                </Link>
                <Link
                    to="/top"
                    className="text-pass hover:text-ink focus-visible:ring-ink rounded-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                    activeProps={{ className: "text-ink underline underline-offset-4" }}
                >
                    Top cats
                </Link>
            </nav>
        </header>
    );
}
