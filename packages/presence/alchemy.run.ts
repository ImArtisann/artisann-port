/**
 * The presence stack: one KV namespace holding the snapshot and content
 * documents, and one Worker that serves them publicly, takes visitor note
 * submissions, and refreshes the GitHub calendar on a cron.
 *
 * Deployed separately from the site so a portfolio build never redeploys this
 * Worker, and so the stored documents survive every site deploy.
 *
 * The photo gallery reads the assets stack's existing physical bucket through
 * a native `r2_bucket` binding — this stack never owns or provisions a bucket.
 */
import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_ASSETS_BUCKET_NAME, DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import { GITHUB_CRON, PRESENCE_HOST, PRESENCE_KV_TITLE } from "./src/config.ts";

export default Alchemy.Stack(
    "ArtisannPortfolioPresence",
    {
        providers: Cloudflare.providers(),
        state: Layer.unwrap(
            Effect.map(Alchemy.AlchemyContext, (context) =>
                context.dev ? Alchemy.localState() : Cloudflare.state(),
            ),
        ),
    },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        const { dev } = yield* Alchemy.AlchemyContext;
        if (dev && stage === "prod") {
            return yield* Effect.die("Use --stage dev for isolated local development.");
        }

        const snapshots = yield* Cloudflare.KV.Namespace("Snapshots", {
            title: stage === "prod" ? PRESENCE_KV_TITLE : `${PRESENCE_KV_TITLE}-${stage}`,
        });

        const worker = yield* Cloudflare.Worker("Presence", {
            // Absolute so the stack deploys identically from the repository
            // root and from this package directory.
            main: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
            dev: { mode: "worker", port: 1338, strictPort: true },
            env: {
                PRESENCE_KV: snapshots,
                PORT_GITHUB_TOKEN: dev ? "" : Config.redacted("PORT_GITHUB_TOKEN"),
                // Local note submission must not post into the production review channel.
                DISCORD_NOTES_WEBHOOK_URL: dev ? "" : Config.redacted("DISCORD_NOTES_WEBHOOK_URL"),
                TURNSTILE_SECRET_KEY: dev ? "" : Config.redacted("TURNSTILE_SECRET_KEY"),
                DISCORD_NOTES_CHANNEL_ID: Config.string("DISCORD_NOTES_CHANNEL_ID"),
                WEBSITE_ORIGIN: dev
                    ? "http://localhost:3000"
                    : Config.string("WEBSITE_ORIGIN").pipe(
                          Config.withDefault("https://www.artisann.dev"),
                      ),
                CONTENT_WRITER_TOKEN: Config.redacted("CONTENT_WRITER_TOKEN"),
                ASSETS_HOST: Config.string("ASSETS_HOST").pipe(
                    Config.withDefault(DEFAULT_ASSETS_HOST),
                ),
            },
            crons: !dev && stage === "prod" ? [GITHUB_CRON] : [],
            domain: !dev && stage === "prod" ? PRESENCE_HOST : undefined,
            compatibility: { flags: ["nodejs_compat"] },
        });

        // Production binds the assets stack's existing bucket. Development
        // instead owns a virtual local bucket, never a remote R2 binding.
        const bucketName = dev
            ? (yield* Cloudflare.R2.Bucket("DevPhotos", {})).bucketName
            : yield* Config.string("ASSETS_BUCKET_NAME").pipe(
                  Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
              );
        yield* worker.bind("photos:r2", {
            bindings: [{ type: "r2_bucket", name: "PHOTOS", bucketName }],
        });

        // The authoritative site-content writer lives in this Worker's own
        // script; the binding row also drives the DO class migration, and
        // `alchemy dev` emulates it locally.
        yield* worker.bind("content-writer:do", {
            bindings: [
                {
                    type: "durable_object_namespace",
                    name: "CONTENT_WRITER",
                    className: "ContentWriter",
                },
            ],
        });

        // A new SQLite class; existing ContentWriter data stays on this script.
        yield* worker.bind("presence:do", {
            bindings: [
                {
                    type: "durable_object_namespace",
                    name: "PRESENCE",
                    className: "PresenceDO",
                },
            ],
        });

        // Cloudflare's simple edge rate limiter (100 requests / 60 seconds per
        // key) guards the public note-submission route; namespace 1002 is the
        // preset that matches those numbers.
        yield* worker.bind("notes:ratelimit", {
            bindings: [
                {
                    type: "ratelimit",
                    name: "NOTES_RATE_LIMIT",
                    namespaceId: "1002",
                    simple: { limit: 100, period: 60 },
                },
            ],
        });

        return {
            url: worker.url,
            namespaceId: snapshots.namespaceId.as<string>(),
            kvTitle: PRESENCE_KV_TITLE,
        };
    }),
);
