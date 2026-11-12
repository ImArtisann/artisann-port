import {
    ContentDocumentStore,
    ContentDocumentUnavailable,
} from "@artisann-port/portfolio-domain/content/content-document-store";
import { SiteContent } from "@artisann-port/portfolio-domain/content";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CmsBindings } from "./cms-service.ts";
import { CONTENT_KEY } from "./config.ts";

export const KvContentDocumentsLive = Layer.effect(
    ContentDocumentStore,
    Effect.gen(function* () {
        const { snapshots } = yield* CmsBindings;
        return ContentDocumentStore.of({
            write: Effect.fn("Portfolio.writeContentProjection")(function* (content) {
                const document = yield* Schema.encodeEffect(Schema.fromJsonString(SiteContent))(
                    content,
                ).pipe(Effect.mapError(() => new ContentDocumentUnavailable()));
                yield* Effect.tryPromise({
                    try: () => snapshots.put(CONTENT_KEY, document),
                    catch: () => new ContentDocumentUnavailable(),
                }).pipe(
                    Effect.timeoutOrElse({
                        duration: "10 seconds",
                        orElse: () => Effect.fail(new ContentDocumentUnavailable()),
                    }),
                );
            }),
        });
    }),
);
