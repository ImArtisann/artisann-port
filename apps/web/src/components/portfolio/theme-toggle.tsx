/** @jsxImportSource react */
import { Button } from "@artisann-port/ui/components/button";
import { cn } from "@artisann-port/ui/lib/utils";
import { Moon02Icon, Sun03Icon } from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "theme";
const DARK_CLASS = "dark";

/** Browser UI colour per theme; the document head ships the dark value for the first paint. */
const THEME_COLORS = { dark: "#111214", light: "#F5F6F7" } as const;

type Theme = keyof typeof THEME_COLORS;

const applyThemeColor = (theme: Theme) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta instanceof HTMLMetaElement) meta.content = THEME_COLORS[theme];
};

export type ThemeToggleProps = {
    className?: string;
};

export function ThemeToggle({ className }: ThemeToggleProps) {
    // Dark-first: the server renders the moon control, matching the document's default dark theme.
    const [theme, setTheme] = useState<Theme>("dark");

    useEffect(() => {
        // The inline head script applies the stored theme before paint; adopt whatever it decided.
        const applied = document.documentElement.classList.contains(DARK_CLASS) ? "dark" : "light";
        setTheme(applied);
        applyThemeColor(applied);
    }, []);

    const isDark = theme === "dark";
    const label = isDark ? "Switch to light theme" : "Switch to dark theme";

    function toggleTheme() {
        const next = document.documentElement.classList.toggle(DARK_CLASS) ? "dark" : "light";
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Storage can be unavailable (private mode, blocked cookies); the toggle still works for this visit.
        }
        applyThemeColor(next);
        setTheme(next);
    }

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon-theme"
            aria-label={label}
            title={label}
            onClick={toggleTheme}
            className={cn("text-muted-foreground", className)}
        >
            <HugeiconsIcon icon={isDark ? Moon02Icon : Sun03Icon} aria-hidden="true" />
        </Button>
    );
}
