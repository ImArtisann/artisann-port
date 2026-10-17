import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useState, type ReactNode } from "react";

// A zero default idle TTL derives a zero timeout-wheel resolution unless overridden.
const browserRegistry = import.meta.env.SSR
    ? null
    : AtomRegistry.make({ scheduleTask, defaultIdleTTL: 0, timeoutResolution: 1 });

/** One browser registry; every SSR root instead owns an inert render-local registry. */
export function SharedAtomRegistry({ children }: { children: ReactNode }) {
    const [registry] = useState(
        () =>
            browserRegistry ??
            AtomRegistry.make({ scheduleTask, defaultIdleTTL: 0, timeoutResolution: 1 }),
    );
    return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}
