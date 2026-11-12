import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentDecision } from "../content/content-state.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class LegacyNoteDecisionImported extends Domain.Event("LegacyNoteDecisionImported", {
    decision: ContentDecision.fields.decision,
}) {}
export class ImportNoteDecision extends Domain.Command("ImportNoteDecision", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    input: { decision: ContentDecision.fields.decision },
    events: [LegacyNoteDecisionImported],
    rejects: [PortfolioDenied],
}) {}
