import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SiteContent } from "../content.ts";

export class ContentDocumentUnavailable extends Schema.TaggedError<ContentDocumentUnavailable>()(
    "ContentDocumentUnavailable",
    {},
) {}
export class ContentDocumentStore extends Context.Service<
    ContentDocumentStore,
    {
        readonly write: (content: SiteContent) => Effect.Effect<void, ContentDocumentUnavailable>;
    }
>()("Portfolio/ContentDocumentStore") {}
