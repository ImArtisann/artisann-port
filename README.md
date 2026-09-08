# Artisann portfolio

Static Astro portfolio in a Bun-workspaces monorepo, scaffolded with
[`repo-int`](https://github.com/ImArtisann/repo-int): `config`, `astro`, `ui`
with `--ui-base base`, and `assets`.

## Requirements

- Bun 1.4.2 or newer.
- Node.js 22.12 or newer; CI uses Node.js 24.

## Development

```bash
bun install
bun run dev
```

The Astro server starts on port 3000, or the next available port.

```bash
bun run check
bun run test
bun run build
bun run preview
```

`check` runs Vite+ formatting, lint, and type checks, followed by Astro's
checker. `test` runs the generated Vitest configuration; no tests are currently
defined. `build` generates the assets manifest and builds the static portfolio
into `apps/web/dist`.

Use `bun run format` to format files and `bun run lint` to run lint
independently. Lefthook installs the generated pre-commit checks during
`bun install`.

## Workspaces

| Path                         | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `apps/web`                   | Existing Astro website, portfolio content, styles, and public assets |
| `packages/ui`                | Shared shadcn components using Base UI and the `base-nova` style     |
| `packages/assets`            | R2 asset manifest, deployment, and upload tooling                    |
| `packages/typescript-config` | Shared TypeScript configuration                                      |
| `stacks/github.ts`           | Generated GitHub repository and deployment-secrets stack             |
| `alchemy.run.ts`             | Existing portfolio Cloudflare deployment stack                       |

Portfolio content remains in `apps/web/src/lib/about-me.ts`. Existing images,
icons, and `robots.txt` remain under `apps/web/public` with unchanged URLs.

The root uses repo-int's pinned TypeScript 7 compiler and Effect tooling.
`apps/web` uses TypeScript 6 because `astro check` requires the JavaScript
compiler API, which TypeScript 7 does not provide.

## Shared UI

```bash
bun x --bun shadcn@latest add input --cwd packages/ui
```

Components are exported from `@repo/ui/components/*`; utilities, hooks, and the
shared stylesheet are also exported by `@repo/ui`.

The Astro app depends on `@repo/ui`, but retains its existing stylesheet and
native Astro components. The shared theme is not imported into the portfolio, so
it does not change the existing design. Rendering React-based Base UI components
in Astro requires adding Astro's React integration first.

## Assets

The generated assets package and `apps/web/src/components/AssetImage.astro` are
installed. Existing portfolio images remain local; the R2 image directory starts
empty, so development and builds do not require Cloudflare credentials.

To use R2-hosted images:

1. Copy `packages/assets/.env.example` to `packages/assets/.env` and configure
   `ASSETS_HOST`, `ASSETS_ZONE_ID`, and the bucket settings.
2. Add source images under `packages/assets/images`.
3. Set the public values from `apps/web/.env.assets.example` in `apps/web/.env`.
   Keep R2 credentials out of the app environment.
4. Generate and verify the manifest, provision the bucket, then upload:

```bash
bun run --cwd packages/assets generate
bun run --cwd packages/assets verify
bun run --cwd packages/assets upload:plan
bun run --cwd packages/assets deploy
bun run --cwd packages/assets upload
```

Set the R2 S3 credentials in `packages/assets/.env` before uploading. Commit
source images and the generated manifest. Leave image transformations disabled
unless Cloudflare Image Transformations is enabled for the zone.

## Portfolio deployment

The root stack retains the `ArtisannPortfolio` stack name and resource
identifiers. It uses `Cloudflare.Website.Astro` and the matching
`@alchemy.run/frontend-frameworks` integration to build `apps/web` and deploy
static assets to Cloudflare Workers. The deployment adapter writes assets to
`apps/web/dist/client`; ordinary `bun run build` still writes the standalone
static site to `apps/web/dist`. Production serves `www.artisann.dev`; the apex
`artisann.dev` redirects permanently to the www hostname while preserving paths
and query strings. Non-production stages do not claim these domains.

```bash
bun run login
bun run plan --stage prod --profile admin
bun run deploy --profile admin
```

`login` runs the project-local Alchemy CLI against `stacks/github.ts` with the
`admin` profile and `--configure`, so both Cloudflare and GitHub authentication
providers are explicitly configured. Complete both providers' authentication
prompts. Choose stored credentials to enter a replacement token, or environment
variables to use credentials from the repository's `.env`.

An environment-backed profile reads `CLOUDFLARE_API_TOKEN` from the current
environment or `.env`; its profile name does not select a separate token.
Ordinary `alchemy login` without `--configure` does not refresh environment
credentials. If Cloudflare reports `Unauthorized: Invalid access token`, replace
the rejected token in `.env` or run `bun run login` and configure valid stored
credentials. Do not commit or paste tokens into logs or chat.

The required `@effect/platform-bun` and `@effect/platform-node` peers are
installed at versions compatible with Alchemy's Effect release.

The deployment script explicitly selects `alchemy.run.ts` and the `prod` stage.
Pass `--profile admin` for the profile configured above. In CI, provide
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and run
`bun run deploy --yes` without a local profile.

Authentication and the required Cloudflare permissions must be configured before
planning or deploying. Review the production plan before applying it, especially
after an Alchemy upgrade. The redirect resource owns the zone's
`http_request_dynamic_redirect` phase; preserve any unrelated rules before
changing that phase.

The generated GitHub stack is separate:

```bash
bun run login
bun run deploy:github
```

This provisions the repository settings and deployment secrets defined in
`stacks/github.ts`. The account token includes the existing account permissions
plus zone permissions scoped to `artisann.dev`: zone lookup, DNS updates,
Workers routes, and dynamic URL redirects. The admin Cloudflare credential must
have **Account API Tokens Write** and be allowed to grant these permissions.
Cloudflare also requires **Super Administrator** permission on the account to
create or update account-owned tokens. Adding token-management permission to the
deployment token being created does not authorize the admin credential that
creates it.

The GitHub credential needs access to manage this repository and its Actions
secrets. Fine-grained tokens need repository access and **Secrets: Read and
write**. Both secret resources depend on the repository output, so Alchemy waits
for repository creation before requesting its secret-encryption key.

The GitHub stack is not required to build or run the portfolio locally. Neither
login nor installing dependencies deploys the website; `bun run deploy` does.
