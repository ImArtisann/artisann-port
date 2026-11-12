import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentInactive } from "./content-inactive.rejection.ts";
import { ReviewId, Revision } from "./content-state.ts";
import { ReviewFinal } from "./review-final.rejection.ts";
import { SiteContentId } from "./site-content.id.ts";

export class VisitorNoteRejected extends Domain.Event("VisitorNoteRejected", { id: ReviewId }) {}
export class RejectNote extends Domain.Command("RejectNote", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { id: ReviewId },
    events: [VisitorNoteRejected],
    rejects: [PortfolioDenied, ContentInactive, ReviewFinal],
    reply: { revision: Revision },
}) {}
