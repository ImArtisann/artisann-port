import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
    return createRouter({
        routeTree,
        scrollRestoration: true,
        // These views seed optimistic state from loaders. Revisited routes
        // must mount with fresh data, not a stale snapshot followed by SWR.
        defaultStaleReloadMode: "blocking",
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
