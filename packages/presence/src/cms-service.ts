import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ApiUnavailable, ContentWriteError } from "./api-errors.ts";
import { readContent, type SiteContent } from "./content.ts";
import {
    CONTENT_WRITER_BODY_BYTES_MAX,
    ContentWriterAction,
    ContentWriterErrorKind,
    ContentWriterResult,
    ContentWriterState,
    type ContentWriterStub,
} from "./content-writer.ts";
import type { PresenceKvBinding } from "./store.ts";

export class CmsBindings extends Context.Service<
    CmsBindings,
    {
        readonly snapshots: PresenceKvBinding;
        readonly writer: ContentWriterStub;
    }
>()("Cms.Bindings") {}

export class CmsContentService extends Context.Service<
    CmsContentService,
    {
        readonly get: Effect.Effect<SiteContent, ApiUnavailable>;
        readonly readState: Effect.Effect<ContentWriterState, ApiUnavailable>;
        readonly apply: (
            action: ContentWriterAction,
        ) => Effect.Effect<ContentWriterResult, ContentWriteError | ApiUnavailable>;
    }
>()("Cms.ContentService") {}

const PrivateResult = Schema.Union([
    ContentWriterResult,
    Schema.Struct({ error: ContentWriterErrorKind }),
]);

export const CmsContentLive = Layer.effect(
    CmsContentService,
    Effect.gen(function* () {
        const bindings = yield* CmsBindings;
        const get = readContent(bindings.snapshots).pipe(
            Effect.mapError(() => new ApiUnavailable({ operation: "content.get" })),
            Effect.withSpan("Cms.get"),
        );
        const readState = Effect.tryPromise({
            try: () => bindings.writer.getState(),
            catch: () => new ApiUnavailable({ operation: "content.state" }),
        }).pipe(
            Effect.flatMap(Schema.decodeEffect(ContentWriterState)),
            Effect.mapError(() => new ApiUnavailable({ operation: "content.state" })),
            Effect.withSpan("Cms.readState"),
        );
        const apply = Effect.fn("Cms.apply")(function* (action: ContentWriterAction) {
            const value = yield* Schema.decodeEffect(ContentWriterAction)(action).pipe(
                Effect.mapError(() => new ContentWriteError({ kind: "validation" })),
            );
            const document = yield* Schema.encodeEffect(Schema.fromJsonString(ContentWriterAction))(
                value,
            ).pipe(Effect.mapError(() => new ContentWriteError({ kind: "validation" })));
            if (new TextEncoder().encode(document).byteLength > CONTENT_WRITER_BODY_BYTES_MAX) {
                return yield* new ContentWriteError({ kind: "capacity" });
            }
            const result = yield* Effect.tryPromise({
                try: () => bindings.writer.apply(value),
                catch: () => new ApiUnavailable({ operation: "content.apply" }),
            }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(PrivateResult)),
                Effect.mapError(() => new ApiUnavailable({ operation: "content.apply" })),
            );
            if ("error" in result) return yield* new ContentWriteError({ kind: result.error });
            return result;
        });
        return CmsContentService.of({ get, readState, apply });
    }),
);
