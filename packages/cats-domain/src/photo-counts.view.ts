import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Photo } from "./photo.aggregate.ts";
export class PhotoCountChanged extends Domain.Event("PhotoCountChanged", { likes: Schema.Int }) {}
export class PhotoCounts extends Domain.View("PhotoCounts", {
    from: [Photo],
    key: Photo,
    state: Schema.Struct({ likes: Schema.Int }),
    initial: { likes: 0 },
    evolve: { HeartRecorded: (_, event) => ({ likes: event.likesAfter }) },
    events: [PhotoCountChanged],
    emit: { HeartRecorded: (event) => new PhotoCountChanged({ likes: event.likesAfter }) },
}) {}
