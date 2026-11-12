import * as Domain from "@alchemy.run/domain";
import { SiteContent } from "../content.ts";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { Revision } from "./content-state.ts";
import { SiteContentId } from "./site-content.id.ts";

export class ContentPublished extends Domain.Event("ContentPublished", {
    content: SiteContent,
    revision: Revision,
}) {}
export class ConfirmContentPublication extends Domain.Command("ConfirmContentPublication", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { content: SiteContent, revision: Revision },
    events: [ContentPublished],
    rejects: [PortfolioDenied],
}) {}
