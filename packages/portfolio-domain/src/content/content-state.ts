import * as Schema from "effect/Schema";
import { SiteContent, VisitorNote, DEFAULT_SITE_CONTENT } from "../content.ts";

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ReviewId = VisitorNote.fields.id;
export const ContentSnapshot = Schema.Struct({
    content: SiteContent,
    revision: Revision,
    publishedRevision: Revision,
    rejected: Schema.Array(ReviewId),
    deleted: Schema.Array(ReviewId),
}).check(
    Schema.makeFilter((snapshot) =>
        snapshot.publishedRevision <= snapshot.revision &&
        new Set(snapshot.rejected).size === snapshot.rejected.length &&
        new Set(snapshot.deleted).size === snapshot.deleted.length
            ? undefined
            : false,
    ),
);
export type ContentSnapshot = typeof ContentSnapshot.Type;

export const ContentState = Schema.Struct({
    ...ContentSnapshot.fields,
    active: Schema.Boolean,
    sourceEpoch: Schema.NullOr(Schema.NonEmptyString),
    sourceSequence: Revision,
});
export type ContentState = typeof ContentState.Type;

export const INITIAL_CONTENT_STATE: ContentState = {
    content: DEFAULT_SITE_CONTENT,
    revision: 0,
    publishedRevision: 0,
    rejected: [],
    deleted: [],
    active: false,
    sourceEpoch: null,
    sourceSequence: 0,
};
