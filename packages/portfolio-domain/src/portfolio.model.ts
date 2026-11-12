import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { SiteContentAggregate } from "./content/site-content.aggregate.ts";
import { PublishedContent } from "./content/published-content.view.ts";
import {
    ContentPublication,
    ContentPublicationLive,
} from "./content/content-publication.projection.ts";
import {
    ContentPublicationConfirmation,
    ContentPublicationConfirmationLive,
} from "./content/content-publication.policy.ts";
import { PublicationReceipts } from "./content/publication-receipts.stream.ts";
import { NoteReview } from "./notes/note-review.aggregate.ts";
import { PhotoOperations } from "./photo/photo.aggregate.ts";

export class Portfolio extends Domain.Model("Portfolio", {
    aggregates: [SiteContentAggregate, NoteReview, PhotoOperations],
    views: [PublishedContent],
    projections: [ContentPublication],
    policies: [ContentPublicationConfirmation],
    streams: [PublicationReceipts],
}) {}
export const PortfolioHandlers = Layer.mergeAll(
    ContentPublicationLive,
    ContentPublicationConfirmationLive,
);
