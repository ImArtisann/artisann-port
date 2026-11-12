import * as Domain from "@alchemy.run/domain";
import { SiteContent } from "../content.ts";
import { PortfolioAuthority, PortfolioDenied } from "../portfolio-authority.middleware.ts";
import { ContentInactive } from "./content-inactive.rejection.ts";
import { Revision } from "./content-state.ts";
import { SiteContentId } from "./site-content.id.ts";

export class ContentRevisionConflict extends Domain.Rejection("ContentRevisionConflict", {
    expected: Revision,
    actual: Revision,
}) {}
export class ModeratedNotesImmutable extends Domain.Rejection("ModeratedNotesImmutable") {}
export class SiteContentReplaced extends Domain.Event("SiteContentReplaced", {
    content: SiteContent,
    revision: Revision,
}) {}
export class ReplaceContent extends Domain.Command("ReplaceContent", {
    target: SiteContentId,
    middleware: [PortfolioAuthority],
    input: { revision: Revision, content: SiteContent },
    events: [SiteContentReplaced],
    rejects: [PortfolioDenied, ContentInactive, ContentRevisionConflict, ModeratedNotesImmutable],
    reply: { revision: Revision },
}) {}
