import * as Domain from "@alchemy.run/domain";
import { IsoTimestamp } from "../content.ts";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentInactive } from "./content-inactive.rejection.ts";
import { ReviewId, Revision } from "./content-state.ts";
import { ReviewFinal } from "./review-final.rejection.ts";
import { SiteContentId } from "./site-content.id.ts";

export class VisitorNoteDeleted extends Domain.Event("VisitorNoteDeleted", {
    id: ReviewId,
    revision: Revision,
    updatedAt: IsoTimestamp,
}) {}
export class DeleteNote extends Domain.Command("DeleteNote", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { id: ReviewId },
    events: [VisitorNoteDeleted],
    rejects: [PortfolioDenied, ContentInactive, ReviewFinal],
    reply: { revision: Revision },
}) {}
