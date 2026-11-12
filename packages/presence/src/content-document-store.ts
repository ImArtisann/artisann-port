import {
    ContentDocumentStore,
    ContentDocumentUnavailable,
} from "@artisann-port/portfolio-domain/content/content-document-store";
import { SiteContent } from "@artisann-port/portfolio-domain/content";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { CmsBindings } from "./cms-service.ts";
import { CONTENT_KEY } from "./config.ts";

export const KvContentDocumentsLive = Layer.effect(
    ContentDocumentStore,
    Effect.gen(function* () {
        const { snapshots } = yield* CmsBindings;
        const lock = yield* Semaphore.make(1);
        // A timed-out put can still commit later. Issue no other put until it settles, or
        // that stale document could overwrite a newer, already confirmed publication.
        let outstanding: Promise<void> = Promise.resolve();
        return ContentDocumentStore.of({
            write: Effect.fn("Portfolio.writeContentProjection")(function* (content) {
                const document = yield* Schema.encodeEffect(Schema.fromJsonString(SiteContent))(
                    content,
                ).pipe(Effect.mapError(() => new ContentDocumentUnavailable()));
                yield* Effect.promise(() => outstanding).pipe(
                    Effect.andThen(
                        Effect.tryPromise({
                            try: () => {
                                const put = snapshots.put(CONTENT_KEY, document);
                                outstanding = put.then(
                                    () => undefined,
                                    () => undefined,
                                );
                                return put;
                            },
                            catch: () => new ContentDocumentUnavailable(),
                        }),
                    ),
                    Effect.timeoutOrElse({
                        duration: "10 seconds",
                        orElse: () => Effect.fail(new ContentDocumentUnavailable()),
                    }),
                    lock.withPermit,
                );
            }),
        });
    }),
);
