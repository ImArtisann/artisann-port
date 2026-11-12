import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { DEFAULT_ASSETS_BUCKET_NAME } from "@artisann-port/assets/config";
import { Likes } from "./src/server/database.ts";
import CatsBackend from "./src/server/worker.ts";

export default Alchemy.Stack(
    "JakesCats",
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        const likes = yield* Likes;
        const backend = yield* CatsBackend;
        const bucketName = yield* Config.NonEmptyString("ASSETS_BUCKET_NAME").pipe(
            Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
        );
        yield* backend.bind("photos:r2", {
            bindings: [{ type: "r2_bucket", name: "PHOTOS", bucketName }],
        });
        yield* backend.bind("visitor:ratelimit", {
            bindings: [
                {
                    type: "ratelimit",
                    name: "VISITOR_RATE_LIMIT",
                    namespaceId: "1003",
                    simple: { limit: 60, period: 60 },
                },
            ],
        });
        const website = yield* Cloudflare.Website.Foldkit("Website", {
            rootDir: fileURLToPath(new URL(".", import.meta.url)),
            env: { CATS: backend },
            assets: { runWorkerFirst: ["/api/*"] },
            domain:
                stage === "prod" ? { name: "jakes.cat", aliases: ["www.jakes.cat"] } : undefined,
        });
        return {
            url: website.url,
            backendUrl: backend.url,
            databaseId: likes.databaseId.as<string>(),
        };
    }),
);
