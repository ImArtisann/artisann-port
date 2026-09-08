/**
 * Presence persistence: one narrow contract over a single string value, plus
 * the adapters that satisfy it — a Workers KV binding inside the Worker, the
 * Cloudflare KV REST API for the deploy-time seed.
 *
 * The store deliberately knows nothing about the snapshot's shape. Encoding
 * lives in `presence.ts`, so decoding a persisted value happens in exactly one
 * place and an adapter can never write a half-valid snapshot.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import { PRESENCE_SNAPSHOT_KEY } from "./config.ts";

/**
 * Storage refused to answer. A failed read never falls back to "no song": the
 * caller must not overwrite a snapshot it could not see.
 */
export class PresenceStoreError extends Schema.TaggedError<PresenceStoreError>()(
    "Presence.StoreError",
    { operation: Schema.String, cause: Schema.Defect() },
) {}

/**
 * The whole persistence surface the presence logic needs: read the stored
 * snapshot document, write a replacement. `Option.none()` means the key has
 * never been written — not an error, and not an empty song.
 */
export interface PresenceStore {
    readonly read: Effect.Effect<Option.Option<string>, PresenceStoreError>;
    readonly write: (document: string) => Effect.Effect<void, PresenceStoreError>;
}

/**
 * The subset of a Workers KV binding the presence Worker uses. Declared
 * structurally so the Worker needs no `@cloudflare/workers-types` dependency,
 * and so `put` cannot be called with a TTL — the last song never expires.
 */
export interface PresenceKvBinding {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
}

/** Bind the snapshot key to a Workers KV namespace binding. */
export function kvPresenceStore(namespace: PresenceKvBinding): PresenceStore {
    return {
        read: Effect.tryPromise({
            try: () => namespace.get(PRESENCE_SNAPSHOT_KEY),
            catch: (cause) => new PresenceStoreError({ operation: "kv.get", cause }),
        }).pipe(Effect.map(Option.fromNullOr)),
        write: (document) =>
            Effect.tryPromise({
                try: () => namespace.put(PRESENCE_SNAPSHOT_KEY, document),
                catch: (cause) => new PresenceStoreError({ operation: "kv.put", cause }),
            }),
    };
}

/** Everything needed to reach one KV namespace over the Cloudflare REST API. */
export interface CloudflareKvAccess {
    readonly accountId: string;
    readonly namespaceId: string;
    readonly apiToken: Redacted.Redacted<string>;
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const KvNamespaceList = Schema.Struct({
    success: Schema.Boolean,
    result: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String }))),
});

/**
 * Look up a namespace id by its stable title, so a seed never has to be handed
 * an id that only Alchemy's state knows.
 */
export const findKvNamespaceId = Effect.fn("Presence.findKvNamespaceId")(function* (
    accountId: string,
    apiToken: Redacted.Redacted<string>,
    title: string,
) {
    const client = yield* HttpClient.HttpClient;
    const url = `${CLOUDFLARE_API}/accounts/${accountId}/storage/kv/namespaces`;
    const response = yield* client
        .get(url, {
            acceptJson: true,
            headers: { authorization: `Bearer ${Redacted.value(apiToken)}` },
            urlParams: { per_page: "100" },
        })
        .pipe(
            Effect.mapError(
                (cause) => new PresenceStoreError({ operation: "kv.listNamespaces", cause }),
            ),
        );
    const body = yield* HttpIncomingMessage.schemaBodyJson(KvNamespaceList)(response).pipe(
        Effect.mapError(
            (cause) => new PresenceStoreError({ operation: "kv.listNamespaces", cause }),
        ),
    );
    const found = (body.result ?? []).find((namespace) => namespace.title === title);
    if (!body.success || found === undefined) {
        return yield* new PresenceStoreError({
            operation: "kv.listNamespaces",
            cause: `No KV namespace titled ${title} in account ${accountId}`,
        });
    }
    return found.id;
});

/**
 * Cloudflare's KV REST API as a {@link PresenceStore}. The client is passed in
 * rather than required from the environment so the store keeps the plain
 * `PresenceStore` shape every caller shares.
 *
 * Writes go through the bulk endpoint: it takes JSON (no multipart body) and,
 * with neither `expiration` nor `expiration_ttl`, stores a value that never
 * expires.
 */
export function restPresenceStore(
    access: CloudflareKvAccess,
    client: HttpClient.HttpClient,
): PresenceStore {
    const base = `${CLOUDFLARE_API}/accounts/${access.accountId}/storage/kv/namespaces/${access.namespaceId}`;
    const authorization = `Bearer ${Redacted.value(access.apiToken)}`;
    return {
        read: Effect.gen(function* () {
            const response = yield* client
                .get(`${base}/values/${PRESENCE_SNAPSHOT_KEY}`, { headers: { authorization } })
                .pipe(
                    Effect.mapError(
                        (cause) => new PresenceStoreError({ operation: "kv.rest.get", cause }),
                    ),
                );
            if (response.status === 404) return Option.none();
            if (response.status >= 300) {
                return yield* new PresenceStoreError({
                    operation: "kv.rest.get",
                    cause: `Cloudflare returned ${response.status}`,
                });
            }
            const text = yield* response.text.pipe(
                Effect.mapError(
                    (cause) => new PresenceStoreError({ operation: "kv.rest.get", cause }),
                ),
            );
            return Option.some(text);
        }),
        write: (document) =>
            Effect.gen(function* () {
                const request = HttpClientRequest.put(`${base}/bulk`, {
                    headers: { authorization },
                    acceptJson: true,
                }).pipe(
                    HttpClientRequest.bodyJsonUnsafe([
                        { key: PRESENCE_SNAPSHOT_KEY, value: document },
                    ]),
                );
                const response = yield* client
                    .execute(request)
                    .pipe(
                        Effect.mapError(
                            (cause) => new PresenceStoreError({ operation: "kv.rest.put", cause }),
                        ),
                    );
                if (response.status >= 300) {
                    return yield* new PresenceStoreError({
                        operation: "kv.rest.put",
                        cause: `Cloudflare returned ${response.status}`,
                    });
                }
            }),
    };
}
