import * as Schema from "effect/Schema";
import { SiteContent, VisitorNote, DEFAULT_SITE_CONTENT } from "../content.ts";

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ReviewId = VisitorNote.fields.id;
/**
 * Content authority without moderation history. Rejected and deleted note IDs
 * are unbounded, so each lives in its own `NoteReview` aggregate instead.
 */
export const ContentSnapshot = Schema.Struct({
    content: SiteContent,
    revision: Revision,
    publishedRevision: Revision,
}).check(
    Schema.makeFilter((snapshot) =>
        snapshot.publishedRevision <= snapshot.revision ? undefined : false,
    ),
);
export type ContentSnapshot = typeof ContentSnapshot.Type;

/** One final moderation decision, migrated one aggregate at a time. */
export const ContentDecision = Schema.Struct({
    id: ReviewId,
    decision: Schema.Literals(["rejected", "deleted"]),
});
export type ContentDecision = typeof ContentDecision.Type;

export const ContentState = Schema.Struct({
    ...ContentSnapshot.fields,
    active: Schema.Boolean,
    sourceEpoch: Schema.NullOr(Schema.NonEmptyString),
    sourceSequence: Revision,
    /** Source decision marker key after which the paged decision import resumes. */
    decisionCursor: Schema.NullOr(Schema.NonEmptyString),
    /** Every decision present when its paged import started has been imported. */
    decisionsImported: Schema.Boolean,
});
export type ContentState = typeof ContentState.Type;

export const INITIAL_CONTENT_STATE: ContentState = {
    content: DEFAULT_SITE_CONTENT,
    revision: 0,
    publishedRevision: 0,
    active: false,
    sourceEpoch: null,
    sourceSequence: 0,
    decisionCursor: null,
    decisionsImported: false,
};
