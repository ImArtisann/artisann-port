import * as Domain from "@alchemy.run/domain";
import { SiteContent } from "../content.ts";
import { Revision } from "./content-state.ts";
import { SiteContentAggregate } from "./site-content.aggregate.ts";

export class ContentProjectionSucceeded extends Domain.Event("ContentProjectionSucceeded", {
    content: SiteContent,
    revision: Revision,
}) {}
export class PublicationReceipts extends Domain.Stream("PublicationReceipts", {
    key: SiteContentAggregate,
    entries: [ContentProjectionSucceeded],
}) {}
