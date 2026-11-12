import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class NoteApprovalSettled extends Domain.Event("NoteApprovalSettled", {
    approved: Schema.Boolean,
}) {}
/** Ends a claimed approval: published, or released when content refused the note. */
export class SettleNoteApproval extends Domain.Command("SettleNoteApproval", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    input: { approved: Schema.Boolean },
    events: [NoteApprovalSettled],
    rejects: [PortfolioDenied],
}) {}
