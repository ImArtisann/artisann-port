import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const OWNER = "ImArtisann";
const REPOSITORY = "artisann-port";

/**
 * One-shot stack for https://github.com/ImArtisann/artisann-port: converges the
 * repository settings, mints a scoped Cloudflare deployment token, and stores it
 * as GitHub Actions secrets. Deploy with `bun run deploy:github` after
 * `bun run login`.
 */
export default Alchemy.Stack(
    "ArtisannPortfolioGitHub",
    {
        providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
        state: Cloudflare.state(),
    },
    Effect.gen(function* () {
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
    }),
);
