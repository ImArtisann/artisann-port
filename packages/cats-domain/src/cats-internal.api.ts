import * as Domain from "@alchemy.run/domain";
import { Cats } from "./cats.model.ts";
export class CatsInternalApi extends Domain.Api("CatsInternalApi", {
    model: Cats,
    commands: ["HeartPhoto", "AcceptComment", "ImportPhotoFact"],
    aggregates: ["Photo"],
    views: [],
    streams: [],
}) {}
