import * as Domain from "@alchemy.run/domain";
import { Portfolio } from "./portfolio.model.ts";

export class PortfolioApi extends Domain.Api("PortfolioApi", {
    model: Portfolio,
    commands: [],
    views: ["PublishedContent"],
    streams: [],
    aggregates: [],
}) {}
