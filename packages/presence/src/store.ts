/**
 * Document persistence: one narrow contract over a single string value and
 * the native Workers KV adapter that satisfies it.
 *
 * The store deliberately knows nothing about a document's shape. Encoding
 * lives with each document (`presence.ts`, `content.ts`), so decoding a
 * persisted value happens in exactly one place per document and an adapter can
 * never write a half-valid one. The key is a parameter: the same adapter backs
 * the presence snapshot and the site-content document.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Storage refused to answer. A failed read never falls back to "no document":
 * the caller must not overwrite a value it could not see.
 *
 * `status` is retained for the shared error contract and is `null` for native
 * binding failures. It never carries a provider message or a header set —
 * domain callers see an operation name and a status number, nothing else.
 */
export class DocumentStoreError extends Schema.TaggedError<DocumentStoreError>()(
    "Document.StoreError",
    { operation: Schema.String, status: Schema.NullOr(Schema.Int) },
) {}

/**
 * The whole persistence surface a document needs: read the stored document,
 * write a replacement. `Option.none()` means the key has never been written —
 * not an error, and not an empty document.
 */
export interface DocumentStore {
    readonly read: Effect.Effect<Option.Option<string>, DocumentStoreError>;
    readonly write: (document: string) => Effect.Effect<void, DocumentStoreError>;
}

/**
 * The subset of a Workers KV binding the presence Worker uses. Declared
 * structurally so the Worker needs no `@cloudflare/workers-types` dependency,
 * and so `put` cannot be called with a TTL — a stored document never expires.
 */
export interface PresenceKvBinding {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
}

/** Bind one key of a Workers KV namespace binding as a document store. */
export function kvDocumentStore(namespace: PresenceKvBinding, key: string): DocumentStore {
    return {
        read: Effect.tryPromise({
            try: () => namespace.get(key),
            catch: () => new DocumentStoreError({ operation: "kv.get", status: null }),
        }).pipe(Effect.map(Option.fromNullOr)),
        write: (document) =>
            Effect.tryPromise({
                try: () => namespace.put(key, document),
                catch: () => new DocumentStoreError({ operation: "kv.put", status: null }),
            }),
    };
}
