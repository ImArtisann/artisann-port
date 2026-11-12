import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
    DEFAULT_SITE_CONTENT,
    decodeContentDocument,
} from "@artisann-port/portfolio-domain/content";
import { CONTENT_KEY } from "./config.ts";
import { kvDocumentStore, type PresenceKvBinding } from "./store.ts";
/**
 * Read the site-content document through the Worker's KV binding.
 *
 * A missing key is a cold start and yields {@link DEFAULT_SITE_CONTENT}.
 * Corrupt data or a failed read fails the request — never a partial document,
 * never per-field defaults.
 */
export const readContent = Effect.fn("Presence.readContent")(function* (
    namespace: PresenceKvBinding,
) {
    const store = kvDocumentStore(namespace, CONTENT_KEY);
    const document = yield* store.read;
    if (Option.isNone(document)) return DEFAULT_SITE_CONTENT;
    return yield* decodeContentDocument(document.value);
});
