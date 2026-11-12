import * as Schema from "effect/Schema";

export const SiteContentId = Schema.Literal("site-content");
export type SiteContentId = typeof SiteContentId.Type;
export const SITE_CONTENT_ID: SiteContentId = "site-content";
