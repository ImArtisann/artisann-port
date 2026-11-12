import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SiteContent } from "../content.ts";
import { SiteContentAggregate } from "./site-content.aggregate.ts";

export class ContentHistoryPrivate extends Domain.Rejection("ContentHistoryPrivate") {}
export class PublicContentChanged extends Domain.Event("PublicContentChanged", {
    content: SiteContent,
    revision: Schema.Int,
}) {}
export class PublishedContent extends Domain.View("PublishedContent", {
    from: [SiteContentAggregate],
    key: SiteContentAggregate,
    state: Schema.NullOr(Schema.Struct({ content: SiteContent, revision: Schema.Int })),
    initial: null,
    rejects: [ContentHistoryPrivate],
    validate: (request) =>
        request.mode === "events" || request.mode === "list"
            ? Effect.fail(new ContentHistoryPrivate())
            : Effect.void,
    events: [PublicContentChanged],
    evolve: {
        ContentPublished: (_state, event) => ({ content: event.content, revision: event.revision }),
        LegacyContentImported: (state, event) =>
            event.snapshot.publishedRevision === event.snapshot.revision
                ? { content: event.snapshot.content, revision: event.snapshot.revision }
                : state,
    },
    emit: {
        ContentPublished: (event) =>
            new PublicContentChanged({ content: event.content, revision: event.revision }),
        LegacyContentImported: (event) =>
            event.snapshot.publishedRevision === event.snapshot.revision
                ? new PublicContentChanged({
                      content: event.snapshot.content,
                      revision: event.snapshot.revision,
                  })
                : undefined,
    },
}) {}
