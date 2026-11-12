import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { DEFAULT_ASSETS_BUCKET_NAME } from "@artisann-port/assets/config";
import { GITHUB_CRON, PRESENCE_HOST } from "./src/config.ts";
import { Snapshots } from "./src/database.ts";
import PortfolioBackend from "./src/domain-worker.ts";

export default Alchemy.Stack(
    "ArtisannPortfolioPresence",
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        const snapshots = yield* Snapshots;
        const native = yield* Cloudflare.Worker("Presence", {
            main: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
            env: {
                PRESENCE_KV: snapshots,
                PORT_GITHUB_TOKEN: Config.Redacted("PORT_GITHUB_TOKEN"),
            },
            crons: stage === "prod" ? [GITHUB_CRON] : [],
            domain: stage === "prod" ? PRESENCE_HOST : undefined,
            compatibility: { flags: ["nodejs_compat"] },
        });
        yield* native.bind("content-writer:do", {
            bindings: [
                {
                    type: "durable_object_namespace",
                    name: "CONTENT_WRITER",
                    className: "ContentWriter",
                },
            ],
        });
        yield* native.bind("presence:do", {
            bindings: [
                { type: "durable_object_namespace", name: "PRESENCE", className: "PresenceDO" },
            ],
        });

        const backend = yield* PortfolioBackend;
        const bucketName = yield* Config.NonEmptyString("ASSETS_BUCKET_NAME").pipe(
            Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
        );
        yield* backend.bind("photos:r2", {
            bindings: [{ type: "r2_bucket", name: "PHOTOS", bucketName }],
        });
        yield* backend.bind("legacy-content:do", {
            bindings: [
                {
                    type: "durable_object_namespace",
                    name: "CONTENT_WRITER",
                    className: "ContentWriter",
                    scriptName: native.workerName,
                },
            ],
        });
        yield* backend.bind("native-presence:do", {
            bindings: [
                {
                    type: "durable_object_namespace",
                    name: "PRESENCE",
                    className: "PresenceDO",
                    scriptName: native.workerName,
                },
            ],
        });
        yield* backend.bind("notes:ratelimit", {
            bindings: [
                {
                    type: "ratelimit",
                    name: "NOTES_RATE_LIMIT",
                    namespaceId: "1002",
                    simple: { limit: 100, period: 60 },
                },
            ],
        });
        yield* native.bind("portfolio:service", {
            bindings: [{ type: "service", name: "PORTFOLIO_DOMAIN", service: backend.workerName }],
        });

        return {
            url: native.url,
            domainUrl: backend.url,
            namespaceId: snapshots.namespaceId.as<string>(),
        };
    }),
);
