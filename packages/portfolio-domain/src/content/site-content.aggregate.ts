import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MAX_NOTES, SiteContent, type IsoTimestamp } from "../content.ts";
import { requirePortfolioActor } from "../portfolio-authority.middleware.ts";
import { SiteContentId } from "./site-content.id.ts";
import { ContentState, ContentSnapshot, INITIAL_CONTENT_STATE } from "./content-state.ts";
import { ContentInactive } from "./content-inactive.rejection.ts";
import { ReviewFinal } from "./review-final.rejection.ts";
import {
    ReplaceContent,
    SiteContentReplaced,
    ContentRevisionConflict,
    ModeratedNotesImmutable,
} from "./replace-content.command.ts";
import {
    ApproveNote,
    VisitorNoteApproved,
    NoteReviewPayloadChanged,
    NotesCapacityReached,
} from "./approve-note.command.ts";
import { DeleteNote, VisitorNoteDeleted } from "./delete-note.command.ts";
import {
    ImportContent,
    LegacyContentImported,
    ContentImportConflict,
} from "./import-content.command.ts";
import { LegacyDecisionsImported, RecordDecisionImport } from "./import-decisions.command.ts";
import { ActivateContent, ContentAuthorityActivated } from "./activate-content.command.ts";
import { ConfirmContentPublication, ContentPublished } from "./confirm-publication.command.ts";

const sameNotes = Schema.toEquivalence(SiteContent.fields.notes);
const sameContent = Schema.toEquivalence(SiteContent);
const sameSnapshot = Schema.toEquivalence(ContentSnapshot);

function updatedAt(previous: IsoTimestamp | null, now: DateTime.Utc): IsoTimestamp {
    const next = Math.max(
        DateTime.toEpochMillis(now),
        previous === null ? 0 : Date.parse(previous) + 1,
    );
    return DateTime.formatIso(DateTime.makeUnsafe(next));
}

export class SiteContentAggregate extends Domain.Aggregate("SiteContent", {
    id: SiteContentId,
    state: ContentState,
    initial: INITIAL_CONTENT_STATE,
    commands: [
        ReplaceContent,
        ApproveNote,
        DeleteNote,
        ImportContent,
        RecordDecisionImport,
        ActivateContent,
        ConfirmContentPublication,
    ],
    decide: {
        ReplaceContent: Effect.fn("Portfolio.ReplaceContent")(function* (state, command, context) {
            yield* requirePortfolioActor("owner");
            if (!state.active) return yield* new ContentInactive();
            if (command.revision !== state.revision) {
                return yield* new ContentRevisionConflict({
                    expected: command.revision,
                    actual: state.revision,
                });
            }
            if (!sameNotes(command.content.notes, state.content.notes))
                return yield* new ModeratedNotesImmutable();
            return [
                new SiteContentReplaced({
                    content: {
                        ...command.content,
                        updatedAt: updatedAt(state.content.updatedAt, context.now),
                    },
                    revision: state.revision + 1,
                }),
            ];
        }),
        ApproveNote: Effect.fn("Portfolio.ApproveNote")(function* (state, command, context) {
            yield* requirePortfolioActor("owner");
            if (!state.active) return yield* new ContentInactive();
            // Rejection and deletion finality is decided first by the note's NoteReview.
            const existing = state.content.notes.find((note) => note.id === command.id);
            if (existing !== undefined) {
                if (existing.body !== command.body || existing.name !== command.name)
                    return yield* new NoteReviewPayloadChanged({ id: command.id });
                return yield* new ReviewFinal({ id: command.id, decision: "approved" });
            }
            if (state.content.notes.length >= MAX_NOTES)
                return yield* new NotesCapacityReached({ maximum: MAX_NOTES });
            return [
                new VisitorNoteApproved({
                    note: {
                        id: command.id,
                        name: command.name,
                        body: command.body,
                        submittedAt: command.submittedAt,
                        approvedAt: DateTime.formatIso(context.now),
                    },
                    revision: state.revision + 1,
                    updatedAt: updatedAt(state.content.updatedAt, context.now),
                }),
            ];
        }),
        DeleteNote: Effect.fn("Portfolio.DeleteNote")(function* (state, command, context) {
            yield* requirePortfolioActor("owner");
            if (!state.active) return yield* new ContentInactive();
            if (!state.content.notes.some((note) => note.id === command.id))
                return yield* new ReviewFinal({ id: command.id, decision: "deleted" });
            return [
                new VisitorNoteDeleted({
                    id: command.id,
                    revision: state.revision + 1,
                    updatedAt: updatedAt(state.content.updatedAt, context.now),
                }),
            ];
        }),
        ImportContent: Effect.fn("Portfolio.ImportContent")(function* (state, command) {
            yield* requirePortfolioActor("migration");
            const conflict = (reason: "active" | "epoch" | "sequence" | "snapshot") =>
                new ContentImportConflict({
                    reason,
                    expectedSequence: state.sourceSequence,
                    actualSequence: command.sequence,
                });
            if (state.active) return yield* conflict("active");
            if (state.sourceEpoch !== null && state.sourceEpoch !== command.epoch)
                return yield* conflict("epoch");
            if (state.sourceEpoch !== null && command.sequence < state.sourceSequence)
                return yield* conflict("sequence");
            if (state.sourceEpoch !== null && command.sequence === state.sourceSequence) {
                if (!sameSnapshot(state, command.snapshot)) return yield* conflict("snapshot");
                return [];
            }
            return [
                new LegacyContentImported({
                    snapshot: command.snapshot,
                    epoch: command.epoch,
                    sequence: command.sequence,
                }),
            ];
        }),
        RecordDecisionImport: Effect.fn("Portfolio.RecordDecisionImport")(
            function* (state, command) {
                yield* requirePortfolioActor("migration");
                const conflict = (reason: "active" | "epoch") =>
                    new ContentImportConflict({
                        reason,
                        expectedSequence: state.sourceSequence,
                        actualSequence: state.sourceSequence,
                    });
                if (state.active) return yield* conflict("active");
                if (state.sourceEpoch !== command.epoch) return yield* conflict("epoch");
                // Pages advance in key order; a stale retry must not move the cursor back.
                if (
                    state.decisionsImported ||
                    (!command.complete &&
                        command.cursor !== null &&
                        state.decisionCursor !== null &&
                        command.cursor <= state.decisionCursor)
                )
                    return [];
                return [
                    new LegacyDecisionsImported({
                        epoch: command.epoch,
                        cursor: command.cursor,
                        complete: command.complete,
                    }),
                ];
            },
        ),
        ActivateContent: Effect.fn("Portfolio.ActivateContent")(function* (state, command) {
            yield* requirePortfolioActor("migration");
            if (state.sourceEpoch !== command.epoch || state.sourceSequence !== command.sequence) {
                return yield* new ContentImportConflict({
                    reason: "sequence",
                    expectedSequence: state.sourceSequence,
                    actualSequence: command.sequence,
                });
            }
            // Activating without every final decision would let a stale review reapprove.
            if (!state.decisionsImported)
                return yield* new ContentImportConflict({
                    reason: "decisions",
                    expectedSequence: state.sourceSequence,
                    actualSequence: command.sequence,
                });
            return state.active
                ? []
                : [
                      new ContentAuthorityActivated({
                          epoch: command.epoch,
                          sequence: command.sequence,
                      }),
                  ];
        }),
        ConfirmContentPublication: Effect.fn("Portfolio.ConfirmContentPublication")(
            function* (state, command) {
                yield* requirePortfolioActor("publisher");
                if (
                    !state.active ||
                    command.revision !== state.revision ||
                    state.publishedRevision >= command.revision ||
                    !sameContent(state.content, command.content)
                )
                    return [];
                return [
                    new ContentPublished({ content: command.content, revision: command.revision }),
                ];
            },
        ),
    },
    evolve: {
        SiteContentReplaced: (state, event) => ({
            ...state,
            content: event.content,
            revision: event.revision,
        }),
        VisitorNoteApproved: (state, event) => ({
            ...state,
            content: {
                ...state.content,
                notes: [...state.content.notes, event.note],
                updatedAt: event.updatedAt,
            },
            revision: event.revision,
        }),
        VisitorNoteDeleted: (state, event) => ({
            ...state,
            content: {
                ...state.content,
                notes: state.content.notes.filter((note) => note.id !== event.id),
                updatedAt: event.updatedAt,
            },
            revision: event.revision,
        }),
        LegacyContentImported: (state, event) => ({
            ...state,
            ...event.snapshot,
            sourceEpoch: event.epoch,
            sourceSequence: event.sequence,
        }),
        LegacyDecisionsImported: (state, event) => ({
            ...state,
            decisionCursor: event.cursor,
            decisionsImported: event.complete,
        }),
        ContentAuthorityActivated: (state) => ({ ...state, active: true, publishedRevision: 0 }),
        ContentPublished: (state, event) => ({ ...state, publishedRevision: event.revision }),
    },
    reply: {
        ReplaceContent: (state) => ({ revision: state.revision }),
        ApproveNote: (state) => ({ revision: state.revision }),
        DeleteNote: (state) => ({ revision: state.revision }),
        ImportContent: (state) => ({ sequence: state.sourceSequence }),
        ActivateContent: (state) => ({ revision: state.revision }),
    },
}) {}
