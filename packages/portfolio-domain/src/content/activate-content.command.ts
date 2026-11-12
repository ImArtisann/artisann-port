import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentImportConflict } from "./import-content.command.ts";
import { Revision } from "./content-state.ts";
import { SiteContentId } from "./site-content.id.ts";

export class ContentAuthorityActivated extends Domain.Event("ContentAuthorityActivated", {
    epoch: Schema.NonEmptyString,
    sequence: Revision,
}) {}
export class ActivateContent extends Domain.Command("ActivateContent", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { epoch: Schema.NonEmptyString, sequence: Revision },
    events: [ContentAuthorityActivated],
    rejects: [PortfolioDenied, ContentImportConflict],
    reply: { revision: Revision },
}) {}
