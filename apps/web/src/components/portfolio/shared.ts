export type ResponsiveValue = { desktop: string; mobile: string };

export type AccentName = "violet" | "cyan" | "green" | "peach" | "muted";

export type LinkValue = { desktopLabel: string; mobileLabel: string; href?: string };

export const accentTextClasses = {
    violet: "text-nightfall-violet",
    cyan: "text-nightfall-cyan",
    green: "text-nightfall-green",
    peach: "text-nightfall-peach",
    muted: "text-nightfall-muted",
} satisfies Record<AccentName, string>;

export const accentBackgroundClasses = {
    violet: "bg-nightfall-violet",
    cyan: "bg-nightfall-cyan",
    green: "bg-nightfall-green",
    peach: "bg-nightfall-peach",
    muted: "bg-nightfall-muted",
} satisfies Record<AccentName, string>;

export const sectionAccentStyles = {
    violet: "--section-accent: var(--nightfall-violet)",
    cyan: "--section-accent: var(--nightfall-cyan)",
    green: "--section-accent: var(--nightfall-green)",
    peach: "--section-accent: var(--nightfall-peach)",
    muted: "--section-accent: var(--nightfall-muted)",
} satisfies Record<AccentName, string>;

export function getExternalLinkProps(href: string) {
    return href.startsWith("http://") || href.startsWith("https://")
        ? ({ target: "_blank", rel: "noreferrer" } as const)
        : {};
}
