import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requirePortfolioActor } from "../portfolio-authority.middleware.ts";
import { NoteReviewId } from "./note-review.id.ts";
import { ConfirmNoteReviewQueued, NoteReviewQueued } from "./confirm-note-review-queued.command.ts";
export class NoteReview extends Domain.Aggregate("NoteReview", {
    id: NoteReviewId,
    state: Schema.Struct({ queued: Schema.Boolean }),
    initial: { queued: false },
    commands: [ConfirmNoteReviewQueued],
    decide: {
        ConfirmNoteReviewQueued: Effect.fn("Portfolio.ConfirmNoteReviewQueued")(function* (state) {
            yield* requirePortfolioActor("notes");
            return state.queued ? [] : [new NoteReviewQueued()];
        }),
    },
    evolve: { NoteReviewQueued: () => ({ queued: true }) },
}) {}
