import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const OWNER = "ImArtisann";
const REPOSITORY = "artisann-port";
// Relative to the working directory, like the `.env` that Alchemy loads itself.
const DISCORD_ENV_FILE = ".env.discord";

/**
 * Local values that `.github/workflows` read as Actions secrets. Each one comes from the
 * shell or `.env` (Alchemy's config provider), else from `.env.discord`. A name set in both
 * places with different values fails the deploy instead of silently picking one.
 */
const WORKFLOW_SECRET_NAMES = [
    "HUGE_ICONS_TOKEN",
    "MOTION_TOKEN",
    "PORT_GITHUB_TOKEN",
    "DISCORD_NOTES_WEBHOOK_URL",
    "DISCORD_NOTES_CHANNEL_ID",
    "TURNSTILE_SECRET_KEY",
    "CONTENT_WRITER_TOKEN",
    "TRAKS_SITE_KEY",
] as const;

const readWorkflowSecrets = Effect.fn("readWorkflowSecrets")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const discordEnv = (yield* fs.exists(DISCORD_ENV_FILE).pipe(Effect.orDie))
        ? Option.some(
              yield* ConfigProvider.fromDotEnv({ path: DISCORD_ENV_FILE }).pipe(Effect.orDie),
          )
        : Option.none<ConfigProvider.ConfigProvider>();

    return yield* Effect.forEach(WORKFLOW_SECRET_NAMES, (name) =>
        Effect.gen(function* () {
            const config = Config.option(Config.NonEmptyString(name));
            const local = yield* config;
            const discord = Option.isSome(discordEnv)
                ? yield* config.parse(discordEnv.value)
                : Option.none<string>();
            if (Option.isSome(local) && Option.isSome(discord) && local.value !== discord.value) {
                return yield* Effect.die(
                    new Error(`${name} differs between the shell or .env and .env.discord`),
                );
            }
            const value = Option.orElse(local, () => discord);
            if (Option.isNone(value)) {
                return yield* Effect.die(
                    new Error(`${name} is not set in the shell, .env, or .env.discord`),
                );
            }
            return { name, value: Redacted.make(value.value) };
        }),
    );
});

/**
 * One-shot stack for https://github.com/ImArtisann/artisann-port: converges the
 * repository settings, mints a scoped Cloudflare deployment token, and stores it
 * plus the workflow values from `.env` / `.env.discord` as GitHub Actions secrets.
 * Deploy with `bun run deploy:github` after `bun run login`.
 */
export default Alchemy.Stack(
    "ArtisannPortfolioGitHub",
    {
        providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
        const workflowSecrets = yield* readWorkflowSecrets();
        const repository = yield* GitHub.Repository("Repository", {
            owner: OWNER,
            name: REPOSITORY,
            visibility: "public",
            hasWiki: false,
            hasProjects: false,
            hasDiscussions: false,
            allowMergeCommit: false,
            allowRebaseMerge: false,
            allowSquashMerge: true,
            deleteBranchOnMerge: true,
        });
        // Resource outputs make secret creation wait for the repository to exist.
        const repositoryName = Output.map(repository.fullName, (fullName) =>
            fullName.slice(fullName.indexOf("/") + 1),
        );

        const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
        const zone = yield* Cloudflare.Zone.findZoneByName({
            accountId,
            name: "artisann.dev",
        }).pipe(Effect.orDie);
        if (!zone) {
            return yield* Effect.die(new Error('Cloudflare zone "artisann.dev" was not found'));
        }
        const catsZone = yield* Cloudflare.Zone.findZoneByName({
            accountId,
            name: "jakes.cat",
        }).pipe(Effect.orDie);
        if (!catsZone) {
            return yield* Effect.die(new Error('Cloudflare zone "jakes.cat" was not found'));
        }

        const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("DeploymentToken", {
            accountId,
            policies: [
                {
                    effect: "allow",
                    permissionGroups: [
                        "Secrets Store Write",
                        "Workers Scripts Write",
                        "Workers KV Storage Write",
                        "Workers R2 Storage Write",
                        "D1 Write",
                        "Queues Write",
                        "Account Settings Write",
                        "Workers Tail Read",
                    ],
                    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
                },
                {
                    effect: "allow",
                    permissionGroups: [
                        "Zone Read",
                        "DNS Write",
                        "Workers Routes Write",
                        "Dynamic URL Redirects Write",
                    ],
                    resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" },
                },
                {
                    effect: "allow",
                    permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
                    resources: { [`com.cloudflare.api.account.zone.${catsZone.id}`]: "*" },
                },
            ],
        });

        yield* GitHub.Secret("CloudflareApiToken", {
            owner: OWNER,
            repository: repositoryName,
            name: "CLOUDFLARE_API_TOKEN",
            value: apiToken.value,
        });

        yield* GitHub.Secret("CloudflareAccountId", {
            owner: OWNER,
            repository: repositoryName,
            name: "CLOUDFLARE_ACCOUNT_ID",
            value: Redacted.make(accountId),
        });

        yield* Effect.forEach(workflowSecrets, ({ name, value }) =>
            GitHub.Secret(name, {
                owner: OWNER,
                repository: repositoryName,
                name,
                value,
            }),
        );
    }),
);
