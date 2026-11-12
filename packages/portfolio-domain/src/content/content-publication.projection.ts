import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { SiteContentAggregate } from "./site-content.aggregate.ts";
import { SiteContentReplaced } from "./replace-content.command.ts";
import { VisitorNoteApproved } from "./approve-note.command.ts";
import { VisitorNoteDeleted } from "./delete-note.command.ts";
import { ContentAuthorityActivated } from "./activate-content.command.ts";
import { ContentDocumentStore } from "./content-document-store.ts";
import { PublicationReceipts, ContentProjectionSucceeded } from "./publication-receipts.stream.ts";

export const CONTENT_PUBLICATION_EVENTS = [
    SiteContentReplaced,
    VisitorNoteApproved,
    VisitorNoteDeleted,
    ContentAuthorityActivated,
] as const;
export class ContentPublication extends Domain.Projection("ContentPublication", {
    from: [SiteContentAggregate],
    key: SiteContentAggregate,
    on: CONTENT_PUBLICATION_EVENTS,
    writes: [PublicationReceipts],
}) {}
export const ContentPublicationLive = ContentPublication.toLayer(
    Effect.gen(function* () {
        const documents = yield* ContentDocumentStore;
        const content = yield* SiteContentAggregate;
        const receipts = yield* PublicationReceipts;
        return Effect.fn("Portfolio.projectContent")(function* (batch) {
            for (const input of batch) {
                const state = yield* content.state(input.source);
                if (!state.active) continue;
                yield* documents.write(state.content).pipe(Effect.orDie);
                yield* receipts.append(
                    input,
                    new ContentProjectionSucceeded({
                        content: state.content,
                        revision: state.revision,
                    }),
                );
            }
        });
    }),
);
