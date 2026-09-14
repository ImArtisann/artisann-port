/**
 * The jakes.cat stack: one TanStack Start Website Worker serving the swipe
 * deck, one D1 database holding per-photo heart counts, and a Cloudflare
 * Images binding that transcodes secret-gated uploads to WebP. In production
 * the same Worker also answers on `www.jakes.cat`.
 *
 * The photo gallery reads the assets stack's existing physical bucket through
 * a native `r2_bucket` binding — this stack never owns or provisions a
 * bucket. The D1 database is owned here and migrates on every deploy.
 */
import { fileURLToPath } from "node:url";
import type { D1Database, ImagesBinding } from "@cloudflare/workers-types";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { DEFAULT_ASSETS_BUCKET_NAME, DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";

/**
 * The Worker's `env`, declared by hand: bindings attached with `.bind(...)`
 * (the R2 bucket and the rate limiter) are not visible to `InferEnv`, so the
 * stack's own database and the `.bind` rows share one interface here.
 */
export interface WebsiteEnv {
    readonly LIKES: D1Database;
    readonly IMAGES: ImagesBinding;
    /** Bearer token an iOS Shortcut must present to `POST /api/photos`. */
    readonly CONTENT_WRITER_TOKEN: string;
    readonly ASSETS_HOST: string;
}

export default Alchemy.Stack(
    "JakesCats",
    {
        providers: Cloudflare.providers(),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;

        const likes = yield* Cloudflare.D1.Database("Likes", {
            name: stage === "prod" ? "jakes-cats-likes" : `jakes-cats-likes-${stage}`,
            // Absolute so the stack deploys identically from the repository
            // root and from this app directory.
            migrations: fileURLToPath(new URL("./migrations", import.meta.url)),
        });

        const website = yield* Cloudflare.Website.Vite("Website", {
            // Same reason: `process.cwd()` differs between the root scripts
            // and a package-directory deploy.
            rootDir: fileURLToPath(new URL(".", import.meta.url)),
            env: {
                LIKES: likes,
                IMAGES: Cloudflare.Images.Images("IMAGES"),
                CONTENT_WRITER_TOKEN: Config.redacted("CONTENT_WRITER_TOKEN"),
                ASSETS_HOST: Config.nonEmptyString("ASSETS_HOST").pipe(
                    Config.withDefault(DEFAULT_ASSETS_HOST),
                ),
            },
            // Production answers on both hostnames: the apex is canonical and
            // `www` serves the same Worker through a second managed custom
            // domain (DNS record and edge certificate included).
            domain:
                stage === "prod" ? { name: "jakes.cat", aliases: ["www.jakes.cat"] } : undefined,
        });

        const bucketName = yield* Config.nonEmptyString("ASSETS_BUCKET_NAME").pipe(
            Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
        );
        yield* website.bind("photos:r2", {
            bindings: [{ type: "r2_bucket", name: "PHOTOS", bucketName }],
        });

        // Cloudflare's simple edge rate limiter (60 requests / 60 seconds per
        // key) guards the public heart and comment actions; namespace 1003 is
        // the preset that matches those numbers (presence uses 1002).
        yield* website.bind("visitor:ratelimit", {
            bindings: [
                {
                    type: "ratelimit",
                    name: "VISITOR_RATE_LIMIT",
                    namespaceId: "1003",
                    simple: { limit: 60, period: 60 },
                },
            ],
        });

        return {
            url: website.url,
            databaseId: likes.databaseId.as<string>(),
        };
    }),
);
