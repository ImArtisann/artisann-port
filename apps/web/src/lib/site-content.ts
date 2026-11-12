import type { SiteContent } from "@artisann-port/portfolio-domain/content";
import { PORTFOLIO_API_ORIGIN, isPortfolioApiOrigin } from "@artisann-port/presence/config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { PortfolioHttp, portfolioHttpLayer } from "./api-client.ts";

export const loadSiteContent = (): Promise<SiteContent> => {
    const configured = (import.meta.env.PUBLIC_PORTFOLIO_API_URL ?? PORTFOLIO_API_ORIGIN).trim();
    if (!isPortfolioApiOrigin(configured))
        throw new Error("PUBLIC_PORTFOLIO_API_URL must be a valid portfolio API origin");
    return Effect.runPromise(
        PortfolioHttp.use((http) => http.content).pipe(
            Effect.provide(
                portfolioHttpLayer(new URL(configured).origin).pipe(
                    Layer.provide(FetchHttpClient.layer),
                ),
            ),
        ),
    );
};
