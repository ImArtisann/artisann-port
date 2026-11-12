import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentSnapshot, Revision } from "./content-state.ts";
import { SiteContentId } from "./site-content.id.ts";

export class ContentImportConflict extends Domain.Rejection("ContentImportConflict", {
    reason: Schema.Literals(["active", "epoch", "sequence", "snapshot"]),
    expectedSequence: Revision,
    actualSequence: Revision,
}) {}
export class LegacyContentImported extends Domain.Event("LegacyContentImported", {
    snapshot: ContentSnapshot,
    epoch: Schema.NonEmptyString,
    sequence: Revision,
}) {}
export class ImportContent extends Domain.Command("ImportContent", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { snapshot: ContentSnapshot, epoch: Schema.NonEmptyString, sequence: Revision },
    events: [LegacyContentImported],
    rejects: [PortfolioDenied, ContentImportConflict],
    reply: { sequence: Revision },
}) {}
