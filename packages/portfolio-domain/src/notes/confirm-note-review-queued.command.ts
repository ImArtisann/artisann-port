import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class NoteReviewQueued extends Domain.Event("NoteReviewQueued") {}
export class ConfirmNoteReviewQueued extends Domain.Command("ConfirmNoteReviewQueued", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    events: [NoteReviewQueued],
    rejects: [PortfolioDenied],
}) {}
