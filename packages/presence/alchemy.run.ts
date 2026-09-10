/**
 * The presence stack: one KV namespace holding a single snapshot, and one
 * Worker that serves it publicly and refreshes it on a cron.
 *
 * Deployed separately from the site so a portfolio build never redeploys the
 * writer, and so the stored last song survives every site deploy.
 */
import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { GITHUB_CRON, PRESENCE_CRON, PRESENCE_HOST, PRESENCE_KV_TITLE } from "./src/config.ts";

export default Alchemy.Stack(
    "ArtisannPortfolioPresence",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;

        const snapshots = yield* Cloudflare.KV.Namespace("Snapshots", {
            title: stage === "prod" ? PRESENCE_KV_TITLE : `${PRESENCE_KV_TITLE}-${stage}`,
        });

        const worker = yield* Cloudflare.Worker("Presence", {
            // Absolute so the stack deploys identically from the repository
            // root and from this package directory.
            main: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
            env: {
                PRESENCE_KV: snapshots,
                PORT_GITHUB_TOKEN: Config.redacted("PORT_GITHUB_TOKEN"),
            },
            crons: stage === "prod" ? [PRESENCE_CRON, GITHUB_CRON] : [],
            domain: stage === "prod" ? PRESENCE_HOST : undefined,
            compatibility: { flags: ["nodejs_compat"] },
        });

        return {
            url: worker.url,
            namespaceId: snapshots.namespaceId.as<string>(),
            kvTitle: PRESENCE_KV_TITLE,
        };
    }),
);
