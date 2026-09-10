import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@artisann-port/presence/content";
import { portfolioApiEndpoints, publicClientFor } from "@/lib/rpc-client";

/**
 * Read through the same typed public RPC client used by browser atoms. The
 * registry and runtime are scoped to this build-time invocation so SSR never
 * leaks mutable atom state into another render.
 */
const readContent = Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const client = publicClientFor(portfolioApiEndpoints.rpcUrl);
    yield* AtomRegistry.mount(registry, client.runtime);
    const context = yield* AtomRegistry.getResult(registry, client.runtime);
    const rpc = Context.get(context, client);
    return yield* rpc("content.get", {});
}).pipe(
    Effect.timeout("10 seconds"),
    Effect.provide(AtomRegistry.layerOptions({ defaultIdleTTL: 0, timeoutResolution: 1 })),
    Effect.scoped,
);

/**
 * Reads the published site content at build time so every content section is server-rendered.
 * A Worker outage degrades to the compiled seed document, which is the same content the bot
 * starts from; mounted browser atoms pick up later owner edits.
 */
export const loadSiteContent = (): Promise<SiteContent> =>
    Effect.runPromise(
        readContent.pipe(
            Effect.catch((error) =>
                Effect.logWarning("site content: using compiled defaults", error).pipe(
                    Effect.as(DEFAULT_SITE_CONTENT),
                ),
            ),
        ),
    );
