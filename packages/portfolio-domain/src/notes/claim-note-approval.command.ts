import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ReviewFinal } from "../content/review-final.rejection.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class NoteApprovalClaimed extends Domain.Event("NoteApprovalClaimed") {}
/** Reserves a note for approval before `ApproveNote` publishes it. */
export class ClaimNoteApproval extends Domain.Command("ClaimNoteApproval", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    events: [NoteApprovalClaimed],
    rejects: [PortfolioDenied, ReviewFinal],
}) {}
