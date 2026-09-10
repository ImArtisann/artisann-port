/** @jsxImportSource react */
import type { SiteContent } from "@artisann-port/presence/content";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { contentAtom, portfolioApiEndpoints } from "@/lib/rpc-client";

/**
 * Render the latest successful content result, retaining the server-rendered
 * document while the first request is in flight or a later request fails.
 *
 * The fallback atom belongs to this consumer rather than the shared query
 * atom. It therefore provides the build-time value without seeding (or
 * overwriting) the shared network result when another island hydrates later.
 */
export const useSiteContent = (
    initial: SiteContent,
    endpoint: string = portfolioApiEndpoints.rpcUrl,
): SiteContent => {
    const [fallback] = useState(() => Atom.make(initial));
    const result = useAtomValue(contentAtom(endpoint));
    const fallbackValue = useAtomValue(fallback);
    return AsyncResult.getOrElse(result, () => fallbackValue);
};
