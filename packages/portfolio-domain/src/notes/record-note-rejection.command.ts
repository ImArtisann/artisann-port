import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ReviewFinal } from "../content/review-final.rejection.ts";
import { NoteApprovalPending } from "./note-approval-pending.rejection.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class NoteRejected extends Domain.Event("NoteRejected") {}
export class RecordNoteRejection extends Domain.Command("RecordNoteRejection", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    events: [NoteRejected],
    rejects: [PortfolioDenied, ReviewFinal, NoteApprovalPending],
}) {}
