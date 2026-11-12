import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IsoTimestamp, NoteBody, NoteName, VisitorNote } from "../content.ts";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentInactive } from "./content-inactive.rejection.ts";
import { ReviewFinal } from "./review-final.rejection.ts";
import { ReviewId, Revision } from "./content-state.ts";
import { SiteContentId } from "./site-content.id.ts";

export class NoteReviewPayloadChanged extends Domain.Rejection("NoteReviewPayloadChanged", {
    id: ReviewId,
}) {}
export class NotesCapacityReached extends Domain.Rejection("NotesCapacityReached", {
    maximum: Schema.Int,
}) {}
export class VisitorNoteApproved extends Domain.Event("VisitorNoteApproved", {
    note: VisitorNote,
    revision: Revision,
    updatedAt: IsoTimestamp,
}) {}
export class ApproveNote extends Domain.Command("ApproveNote", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { id: ReviewId, name: NoteName, body: NoteBody, submittedAt: IsoTimestamp },
    events: [VisitorNoteApproved],
    rejects: [
        PortfolioDenied,
        ContentInactive,
        ReviewFinal,
        NoteReviewPayloadChanged,
        NotesCapacityReached,
    ],
    reply: { revision: Revision },
}) {}
