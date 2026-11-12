import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PhotoKey, VisitorId, Timestamp } from "./photo.id.ts";
export const StoredComment = Schema.Struct({
    id: Schema.Int,
    visitorId: VisitorId,
    body: Schema.String,
    createdAt: Timestamp,
});
export class InvalidComment extends Domain.Rejection("InvalidComment") {}
export class CommentAccepted extends Domain.Event("CommentAccepted", {
    comment: StoredComment,
}) {}
// Only the trusted adapter sends this command, after moderation and existence checks.
export class AcceptComment extends Domain.Command("AcceptComment", {
    target: PhotoKey,
    input: { visitorId: VisitorId, body: Schema.String },
    events: [CommentAccepted],
    rejects: [InvalidComment],
    reply: { comment: Schema.NullOr(StoredComment) },
}) {}
