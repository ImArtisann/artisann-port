import * as Domain from "@alchemy.run/domain";
import { Photo } from "./photo.aggregate.ts";
import { HeartRecorded } from "./heart-photo.command.ts";
import { CommentAccepted } from "./accept-comment.command.ts";
export class PhotoIndex extends Domain.Projection("PhotoIndex", {
    from: [Photo],
    key: Photo,
    on: [HeartRecorded, CommentAccepted],
}) {}
