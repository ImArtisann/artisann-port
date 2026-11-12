import * as Domain from "@alchemy.run/domain";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { NoteReviewId } from "./note-review.id.ts";

export class NoteDeleted extends Domain.Event("NoteDeleted") {}
/** Makes deletion final before `DeleteNote` removes the published note. */
export class RecordNoteDeletion extends Domain.Command("RecordNoteDeletion", {
    target: NoteReviewId,
    middleware: [PortfolioAuthority],
    events: [NoteDeleted],
    rejects: [PortfolioDenied],
}) {}
