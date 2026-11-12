import * as Domain from "@alchemy.run/domain";
import { Photo } from "./photo.aggregate.ts";
import { PhotoCounts } from "./photo-counts.view.ts";
import { PhotoIndex } from "./photo-index.projection.ts";
export class Cats extends Domain.Model("Cats", {
    aggregates: [Photo],
    views: [PhotoCounts],
    projections: [PhotoIndex],
}) {}
