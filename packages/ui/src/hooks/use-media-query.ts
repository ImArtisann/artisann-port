import * as React from "react";

/**
 * Track a CSS media query in React.
 *
 * The first render (and the server render) reports `false`, then the effect
 * measures the real value. Callers therefore mount the desktop variant first
 * and swap to the mobile one after hydration, which keeps the static HTML and
 * the first client render identical.
 */
export function useMediaQuery(query: string) {
    const [matches, setMatches] = React.useState(false);

    React.useEffect(() => {
        const mediaQueryList = window.matchMedia(query);
        const onChange = () => setMatches(mediaQueryList.matches);
        mediaQueryList.addEventListener("change", onChange);
        onChange();
        return () => mediaQueryList.removeEventListener("change", onChange);
    }, [query]);

    return matches;
}
