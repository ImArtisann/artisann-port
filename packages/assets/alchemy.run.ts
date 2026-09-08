import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { DEFAULT_ASSETS_BUCKET_NAME } from "./src/config.ts";

export default Alchemy.Stack(
    "ArtisannPortfolioAssets",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
        const bucketName = yield* Config.nonEmptyString("ASSETS_BUCKET_NAME").pipe(
            Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
        );
        const host = yield* Config.nonEmptyString("ASSETS_HOST");
        const zone = yield* Config.nonEmptyString("ASSETS_ZONE_ID");
        const bucket = yield* Cloudflare.R2.Bucket("Assets", {
            name: bucketName,
            domains: [{ name: host, zone, enabled: true, minTLS: "1.2" }],
        });
        return { bucketName: bucket.bucketName.as<string>(), origin: `https://${host}` };
    }),
);
