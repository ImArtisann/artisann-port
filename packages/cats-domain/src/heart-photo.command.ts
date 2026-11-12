import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PhotoKey, VisitorId, Timestamp } from "./photo.id.ts";
export class HeartRecorded extends Domain.Event("HeartRecorded", {
    visitorId: VisitorId,
    createdAt: Timestamp,
    likesAfter: Schema.Int,
}) {}
export class HeartPhoto extends Domain.Command("HeartPhoto", {
    target: PhotoKey,
    input: { visitorId: VisitorId },
    events: [HeartRecorded],
    reply: { likes: Schema.Int },
}) {}
