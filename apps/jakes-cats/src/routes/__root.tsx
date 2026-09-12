import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { SiteHeader } from "../components/site-header.tsx";
import { SITE_MARK_URL, SITE_OG_IMAGE_URL, SITE_URL } from "../contracts.ts";
import appCss from "../styles.css?url";

const SITE_TITLE = "Jake's Cats";
const SITE_DESCRIPTION = "Swipe through Jake's cat photos, heart the good ones, and leave a note.";
const SITE_OG_IMAGE_ALT = "Pixel-art cats — Jake's Cats, created by artisann";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            {
                charSet: "utf-8",
            },
            {
                name: "viewport",
                content: "width=device-width, initial-scale=1, viewport-fit=cover",
            },
            {
                title: SITE_TITLE,
            },
            {
                name: "description",
                content: SITE_DESCRIPTION,
            },
            {
                name: "theme-color",
                content: "#faf3ea",
                media: "(prefers-color-scheme: light)",
            },
            {
                name: "theme-color",
                content: "#171310",
                media: "(prefers-color-scheme: dark)",
            },
            {
                property: "og:title",
                content: SITE_TITLE,
            },
            {
                property: "og:description",
                content: SITE_DESCRIPTION,
            },
            {
                property: "og:type",
                content: "website",
            },
            {
                property: "og:url",
                content: SITE_URL,
            },
            {
                property: "og:image",
                content: SITE_OG_IMAGE_URL,
            },
            {
                property: "og:image:alt",
                content: SITE_OG_IMAGE_ALT,
            },
            {
                name: "twitter:card",
                content: "summary_large_image",
            },
            {
                name: "twitter:image",
                content: SITE_OG_IMAGE_URL,
            },
            {
                name: "twitter:image:alt",
                content: SITE_OG_IMAGE_ALT,
            },
        ],
        links: [
            {
                rel: "stylesheet",
                href: appCss,
            },
            {
                rel: "icon",
                type: "image/webp",
                href: SITE_MARK_URL,
            },
        ],
    }),
    component: RootComponent,
});

function RootComponent() {
    return (
        <Document>
            <SiteHeader />
            <Outlet />
            <SiteFooter />
        </Document>
    );
}

/** Quiet bottom strip on every page: a link back to the portfolio. */
function SiteFooter() {
    return (
        <footer className="border-line mt-auto border-t">
            <p className="text-pass mx-auto w-full max-w-lg px-4 py-6 text-center text-xs">
                A corner of{" "}
                <a
                    href="https://www.artisann.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink hover:text-heart-ink focus-visible:ring-ink rounded-sm underline underline-offset-4 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                >
                    artisann.dev
                </a>
            </p>
        </footer>
    );
}

function Document(props: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body className="bg-cream text-ink flex min-h-dvh flex-col pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] antialiased">
                {props.children}
                <Scripts />
            </body>
        </html>
    );
}
