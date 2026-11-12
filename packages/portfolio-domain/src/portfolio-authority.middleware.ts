import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { CurrentPortfolioActor, type PortfolioActor } from "./portfolio-actor.context.ts";

export class PortfolioDenied extends Domain.Rejection("PortfolioDenied") {}
export class PortfolioAuthority extends RpcMiddleware.Service<
    PortfolioAuthority,
    { provides: CurrentPortfolioActor }
>()("Portfolio/Authority", { error: PortfolioDenied }) {}

export const requirePortfolioActor = Effect.fn("Portfolio.authorize")(function* (
    expected: PortfolioActor,
) {
    if ((yield* CurrentPortfolioActor) !== expected) return yield* new PortfolioDenied();
});
