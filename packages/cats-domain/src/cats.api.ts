import * as Domain from "@alchemy.run/domain";
import { Cats } from "./cats.model.ts";
export class CatsApi extends Domain.Api("CatsApi", {
    model: Cats,
    commands: [],
    views: ["PhotoCounts"],
    aggregates: [],
    streams: [],
}) {}
