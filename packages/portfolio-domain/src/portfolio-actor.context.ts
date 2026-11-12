import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export const PortfolioActor = Schema.Literals(["owner", "migration", "publisher", "notes"]);
export type PortfolioActor = typeof PortfolioActor.Type;
export class CurrentPortfolioActor extends Domain.RequestContext<CurrentPortfolioActor>()(
    "Portfolio/CurrentActor",
    PortfolioActor,
) {}
