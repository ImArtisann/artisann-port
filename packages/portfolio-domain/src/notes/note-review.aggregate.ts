import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requirePortfolioActor } from "../portfolio-authority.middleware.ts";
import { ReviewFinal } from "../content/review-final.rejection.ts";
import { NoteReviewId } from "./note-review.id.ts";
import { ConfirmNoteReviewQueued, NoteReviewQueued } from "./confirm-note-review-queued.command.ts";
import { ClaimNoteApproval, NoteApprovalClaimed } from "./claim-note-approval.command.ts";
import { NoteApprovalSettled, SettleNoteApproval } from "./settle-note-approval.command.ts";
import { NoteRejected, RecordNoteRejection } from "./record-note-rejection.command.ts";
import { NoteDeleted, RecordNoteDeletion } from "./record-note-deletion.command.ts";
import { ImportNoteDecision, LegacyNoteDecisionImported } from "./import-note-decision.command.ts";
import { NoteApprovalPending } from "./note-approval-pending.rejection.ts";

export const NoteReviewState = Schema.Struct({
    queued: Schema.Boolean,
    approval: Schema.Literals(["none", "claimed", "approved"]),
    rejected: Schema.Boolean,
    deleted: Schema.Boolean,
});
export type NoteReviewState = typeof NoteReviewState.Type;

/**
 * One note's moderation lifecycle. Keeping each final decision in its own
 * aggregate bounds every stored value, however long the decision history grows.
 */
export class NoteReview extends Domain.Aggregate("NoteReview", {
    id: NoteReviewId,
    state: NoteReviewState,
    initial: { queued: false, approval: "none", rejected: false, deleted: false },
    commands: [
        ConfirmNoteReviewQueued,
        ClaimNoteApproval,
        SettleNoteApproval,
        RecordNoteRejection,
        RecordNoteDeletion,
        ImportNoteDecision,
    ],
    decide: {
        ConfirmNoteReviewQueued: Effect.fn("Portfolio.ConfirmNoteReviewQueued")(function* (state) {
            yield* requirePortfolioActor("notes");
            return state.queued ? [] : [new NoteReviewQueued()];
        }),
        ClaimNoteApproval: Effect.fn("Portfolio.ClaimNoteApproval")(
            function* (state, _command, context) {
                yield* requirePortfolioActor("owner");
                if (state.rejected)
                    return yield* new ReviewFinal({ id: context.id, decision: "rejected" });
                if (state.deleted)
                    return yield* new ReviewFinal({ id: context.id, decision: "deleted" });
                return state.approval === "none" ? [new NoteApprovalClaimed()] : [];
            },
        ),
        SettleNoteApproval: Effect.fn("Portfolio.SettleNoteApproval")(function* (state, command) {
            yield* requirePortfolioActor("owner");
            return state.approval === "claimed"
                ? [new NoteApprovalSettled({ approved: command.approved })]
                : [];
        }),
        RecordNoteRejection: Effect.fn("Portfolio.RecordNoteRejection")(
            function* (state, _command, context) {
                yield* requirePortfolioActor("owner");
                if (state.rejected)
                    return yield* new ReviewFinal({ id: context.id, decision: "rejected" });
                if (state.approval === "claimed") return yield* new NoteApprovalPending();
                // Like the source writer, only a note that is still published refuses rejection.
                if (state.approval === "approved" && !state.deleted)
                    return yield* new ReviewFinal({ id: context.id, decision: "approved" });
                return [new NoteRejected()];
            },
        ),
        RecordNoteDeletion: Effect.fn("Portfolio.RecordNoteDeletion")(function* (state) {
            yield* requirePortfolioActor("owner");
            return state.deleted ? [] : [new NoteDeleted()];
        }),
        ImportNoteDecision: Effect.fn("Portfolio.ImportNoteDecision")(function* (state, command) {
            yield* requirePortfolioActor("migration");
            const recorded = command.decision === "rejected" ? state.rejected : state.deleted;
            return recorded ? [] : [new LegacyNoteDecisionImported({ decision: command.decision })];
        }),
    },
    evolve: {
        NoteReviewQueued: (state) => ({ ...state, queued: true }),
        NoteApprovalClaimed: (state): NoteReviewState => ({ ...state, approval: "claimed" }),
        NoteApprovalSettled: (state, event): NoteReviewState => ({
            ...state,
            approval: event.approved ? "approved" : "none",
        }),
        NoteRejected: (state) => ({ ...state, rejected: true }),
        NoteDeleted: (state) => ({ ...state, deleted: true }),
        LegacyNoteDecisionImported: (state, event) =>
            event.decision === "rejected"
                ? { ...state, rejected: true }
                : { ...state, deleted: true },
    },
}) {}
