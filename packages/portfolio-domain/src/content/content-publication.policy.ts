import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CurrentPortfolioActor } from "../portfolio-actor.context.ts";
import { SiteContentAggregate } from "./site-content.aggregate.ts";
import {
    ContentPublication,
    CONTENT_PUBLICATION_EVENTS,
} from "./content-publication.projection.ts";
import { PublicationReceipts } from "./publication-receipts.stream.ts";
import { ConfirmContentPublication } from "./confirm-publication.command.ts";

export class ContentPublicationConfirmation extends Domain.Policy(
    "ContentPublicationConfirmation",
    {
        from: SiteContentAggregate,
        on: CONTENT_PUBLICATION_EVENTS,
    },
) {}
export const ContentPublicationConfirmationLive = ContentPublicationConfirmation.toLayer(
    Effect.gen(function* () {
        const progress = yield* ContentPublication.Progress;
        const publications = yield* PublicationReceipts;
        const content = yield* SiteContentAggregate;
        return Effect.fn("Portfolio.confirmPublication")(function* ({ source, event, envelope }) {
            yield* progress
                .caughtUp(
                    { stream: envelope.stream, version: envelope.seq, events: [event] },
                    { timeout: "10 seconds" },
                )
                .pipe(Effect.orDie);
            const receipt = yield* publications.peek(source).pipe(Effect.orDie);
            if (Option.isNone(receipt)) return;
            yield* content
                .send(
                    source,
                    new ConfirmContentPublication({
                        content: receipt.value.event.content,
                        revision: receipt.value.event.revision,
                    }),
                    {
                        commandId: `publication:${receipt.value.envelope.stream}:${receipt.value.envelope.seq}`,
                    },
                )
                .pipe(Effect.provideService(CurrentPortfolioActor, "publisher"), Effect.orDie);
        });
    }),
);
