/**
 * Seeds (or manually refreshes) the stored presence snapshot with real Lanyard
 * data over the Cloudflare KV REST API.
 *
 * Run once after the first deploy so no visitor ever sees the uninitialized
 * snapshot while waiting for the first cron pass. It is the same
 * `refreshPresence` the cron runs, pointed at a REST-backed store, so it can
 * never write a snapshot the Worker would not.
 *
 * From the repository root (so `.env` is loaded):
 *
 *     bun run packages/presence/scripts/seed.ts
 *
 * Reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (the token needs
 * `Workers KV Storage Write`, which deploying the namespace already requires).
 * The namespace is found by its stable title; set
 * `PRESENCE_KV_NAMESPACE_ID` to skip the lookup.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { PRESENCE_KV_TITLE } from "../src/config.ts";
import { refreshPresence } from "../src/presence.ts";
import { findKvNamespaceId, restPresenceStore } from "../src/store.ts";

const seed = Effect.gen(function* () {
    const accountId = yield* Config.nonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const apiToken = yield* Config.redacted("CLOUDFLARE_API_TOKEN");
    const configured = yield* Config.option(Config.nonEmptyString("PRESENCE_KV_NAMESPACE_ID"));
    const namespaceId = Option.isSome(configured)
        ? configured.value
        : yield* findKvNamespaceId(accountId, apiToken, PRESENCE_KV_TITLE);

    const client = yield* HttpClient.HttpClient;
    const snapshot = yield* refreshPresence(
        restPresenceStore({ accountId, namespaceId, apiToken }, client),
    );
    yield* Effect.log(
        `presence seeded (${namespaceId}): status=${snapshot.status ?? "unknown"} ` +
            `playback=${snapshot.playback} song=${snapshot.song?.title ?? "none"}`,
    );
});

await Effect.runPromise(seed.pipe(Effect.provide(FetchHttpClient.layer)));
