import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentImportConflict } from "./import-content.command.ts";
import { SiteContentId } from "./site-content.id.ts";

export class LegacyDecisionsImported extends Domain.Event("LegacyDecisionsImported", {
    epoch: Schema.NonEmptyString,
    cursor: Schema.NullOr(Schema.NonEmptyString),
    complete: Schema.Boolean,
}) {}
/** Records progress after one page of source decisions reached their `NoteReview` aggregates. */
export class RecordDecisionImport extends Domain.Command("RecordDecisionImport", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: {
        epoch: Schema.NonEmptyString,
        cursor: Schema.NullOr(Schema.NonEmptyString),
        complete: Schema.Boolean,
    },
    events: [LegacyDecisionsImported],
    rejects: [PortfolioDenied, ContentImportConflict],
}) {}
