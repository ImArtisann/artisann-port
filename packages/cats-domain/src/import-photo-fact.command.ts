import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PhotoKey, VisitorId, Timestamp } from "./photo.id.ts";
import { HeartRecorded } from "./heart-photo.command.ts";
import { CommentAccepted } from "./accept-comment.command.ts";
export class ImportConflict extends Domain.Rejection("ImportConflict") {}
export class ImportPhotoFact extends Domain.Command("ImportPhotoFact", {
    target: PhotoKey,
    input: {
        kind: Schema.Literals(["heart", "comment"]),
        visitorId: VisitorId,
        createdAt: Timestamp,
        commentId: Schema.NullOr(Schema.Int),
        body: Schema.NullOr(Schema.String),
    },
    events: [HeartRecorded, CommentAccepted],
    rejects: [ImportConflict],
}) {}
