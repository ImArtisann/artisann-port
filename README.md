# Artisann

My personal corner of the internet — projects, open-source work, what I’m
listening to, and a little about life in Dallas.

[Visit the portfolio](https://www.artisann.dev)

## Repository layout

| Path                | What it is                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/web`          | Astro site (`bun run --cwd apps/web dev`, `bun run --cwd apps/web build`).                                |
| `apps/discord`      | Owner-only Discord bot: presence source and website CMS.                                                  |
| `packages/presence` | Shared schemas plus the Cloudflare Worker serving presence, content, photos, GitHub and note submissions. |
| `packages/assets`   | R2 asset tooling and the generated manifest.                                                              |
| `packages/ui`       | Shared UI primitives.                                                                                     |

Run `bun run dev` from the repository root to start both the Astro server and
the Discord bot. Run `bun run deploy --yes` to deploy the presence Worker and
the Astro website to Cloudflare. The Discord container remains outside this
deployment command; Coolify deploys it from GitHub webhooks.

## Discord bot operations

The bot in `apps/discord` is private to one owner in one guild. It uses typed
RPC to publish presence, manage R2 photos, edit site content, and moderate
notes. Separate Durable Objects own presence and site-content writes. KV holds
the public `site-content` read copy. Approve/Reject buttons live in the private
Discord review channel. The bot exposes no HTTP port and needs no local durable
volume.

### Configuration

All configuration comes from the process environment; the bot never reads the
repository's `.env`.

```sh
cp -n .env.discord.example .env.discord   # preserve any existing configuration
```

`.env.discord.example` documents every required variable with blank values and
comments out optional defaults. Omit optional variables to use their defaults;
an explicitly empty value is not a default. `.env.*` files are git-ignored and
excluded from the Docker build context, so no secret reaches a commit or an
image layer. Never pass a secret as a build `ARG` or `ENV`: inject it at run
time only (compose `env_file`, or `docker run --env-file`). If your host has a
secret manager, render `.env.discord` from it at deploy time rather than editing
it by hand.

Run locally against configured resources with:

```sh
bun run discord   # bun --no-env-file --env-file=.env.discord apps/discord/src/main.ts
```

The container entrypoint runs `bun --no-env-file apps/discord/dist/main.js`:
automatic `.env` loading is disabled and compose injects `../../.env.discord`
through the process environment instead.

Startup fails fast and names any missing or invalid variable without printing
its value. Only one process may run against a namespace — stop a running local
process before starting the container, and vice versa.

Set `PORTFOLIO_API_URL` to the Worker’s HTTPS origin. The bot has no default API
origin. Local verification can use an HTTP origin with an explicit port on
`localhost` or `127.0.0.1`. Supply the same nonempty `CONTENT_WRITER_TOKEN` to
the Worker and bot. The bot does not need a Cloudflare management API token,
account ID, KV namespace ID, or bucket name.

The presence Worker also requires the `DISCORD_NOTES_WEBHOOK_URL`,
`TURNSTILE_SECRET_KEY`, and `CONTENT_WRITER_TOKEN` secrets, alongside the
existing `PORT_GITHUB_TOKEN`. Supply these to the Alchemy deployment process;
the bot's `.env.discord` is not loaded by the Worker deployment. Set
`DISCORD_NOTES_CHANNEL_ID` and `WEBSITE_ORIGIN` in that process too. The default
website origin is `https://www.artisann.dev`; local origins are accepted only
when a local development origin is explicitly configured.

Provision an **incoming webhook created by the bot application**. Verify its
`application_id`, `guild_id`, and `channel_id`. This is not an interaction
webhook (Discord type 3), and an ordinary user-owned webhook cannot provide
interactive review buttons.

### Credential rotation

1. **Bot token** — Developer Portal → Bot → _Reset Token_. Any token that has
   ever appeared in chat, a log, a plan document or a screenshot is burned and
   must be reset before the first live connection. Update `.env.discord`, then
   restart the container (`docker compose -f apps/discord/compose.yaml up -d`);
   the old token stops working immediately, so expect a short gap in presence
   updates.
2. **Writer token** — `CONTENT_WRITER_TOKEN` authorizes the bot’s private RPC
   calls. Keep it in the Worker and bot only. If rotation is required, update
   both sides together. Missing or mismatched tokens refuse private reads and
   writes. Do not replace it with a Cloudflare management token.
3. **Notes webhook** — the URL is a secret held in two places: `.env.discord`
   for the bot and a presence Worker secret for the submission route. Rotating
   the webhook means recreating it with the bot application against the same
   private channel and updating both. Grant Manage Webhooks only while
   provisioning, then remove it; runtime needs just View Channel, Send Messages
   and Embed Links (permissions integer 19456).
4. **Turnstile keys** — secret key is a Worker secret; only the site key is
   exposed to the browser.

### Container

```sh
docker build -f apps/discord/Dockerfile -t artisann-discord .          # context = repo root
docker compose -f apps/discord/compose.yaml config --quiet             # validate compose
docker compose -f apps/discord/compose.yaml up -d --build              # run on the VPS
docker compose -f apps/discord/compose.yaml logs -f discord            # inspect startup
```

`apps/discord/Dockerfile` pins `oven/bun:1.4.2`, installs with
`--frozen-lockfile --ignore-scripts`, bundles the app inside Linux, and ships a
runtime stage containing only production dependencies, the app manifest and
`apps/discord/dist`. Both dependency stages install with
`--filter @artisann-port/discord`, so unrelated workspaces that need private
registries (for example the Hugeicons tarball used by `apps/web`/`packages/ui`)
are never fetched and no `.npmrc`/registry credential is required in the build.

The version-locked Distilled core patch remains for Alchemy and asset tooling.
Both Bun source exports and Node ESM exports are patched. The Docker dependency
stages copy `patches/` before installing. Bot photo uploads use binary RPC and
the Worker’s native R2 binding instead of the Cloudflare management API.

Photo commands accept regular and ephemeral Discord attachments. The bot
downloads the supplied signed attachment URL, normalizes the image to WebP, and
uploads it to R2. The private command response displays the R2-hosted image, so
its preview does not depend on the temporary Discord attachment URL.

Project previews use each app’s Open Graph image. The app add/edit modal accepts
optional approved image hostnames, one per line. Blank input clears these
approvals. Projects do not require screenshot uploads. Use `/experience` and
`/facts` to add, edit, or remove work history and personal facts.

Mounted website islands refresh content and photo queries every 60 seconds.
GitHub and weather queries refresh every 15 minutes. Islands share one browser
Atom registry; cached content and photos remain available for 60 seconds after
their last observer leaves. RPC responses use `Cache-Control: no-store`; image
files keep their separate cache policy. Content publication can still take time
to propagate through KV. Photo listings read R2 directly.

Presence uses one WebSocket per endpoint and Atom registry, not polling. The
connection closes when its last consumer leaves. Failed attempts retain the last
snapshot and reconnect with exponential delays from one to thirty seconds; only
a valid snapshot resets that delay. When an observation becomes stale, the
status becomes unavailable and the last song remains visible.
`PUBLIC_PORTFOLIO_API_URL` sets the website’s API origin and defaults to
`https://presence.artisann.dev`. Keep the bot and Worker’s public assets
hostname consistent.

`sharp` is external to the bundle and loaded from its installed Linux native
package, so **build on the machine that will run the image** (or with an
explicit matching `--platform`); macOS native modules are never copied in. The
runtime runs as the unprivileged `bun` user with a read-only root filesystem, a
`tmpfs` `/tmp`, all capabilities dropped, `no-new-privileges`, `init: true` and
`stop_grace_period: 30s`.

Single-writer is an operational duty, not something Compose enforces: the
service defines one container, but a second compose project, a plain
`docker run`, or a bot process on another machine against the same namespace
would still violate it. Before starting, confirm no other bot process is running
against the configured resources (`docker ps`, `pgrep -f discord`, and any other
hosts). The compose file deliberately avoids a fixed container name so isolated
smoke deployments under distinct compose projects remain possible.

The bot needs no Administrator grant: Guild Install with scopes
`bot applications.commands` and permission integer **19456** (View Channel, Send
Messages, Embed Links) is sufficient; presence requires the **Presence Intent**
and Message Content stays disabled. Adding these files implies no registry push
and no CI image publishing.

A container that is merely "up" proves nothing. Check command registration in
the configured guild and a newly observed presence snapshot. Presence no longer
depends on KV propagation. If guild synchronization returns 403/404, the bot
logs that it is waiting for installation and keeps its Gateway listener alive.

### Rollout gates

Each gate must pass before the next; none of them run as part of building this
repository.

1. Configure the bot token and shared writer token. Use the existing namespace
   and bucket for production and isolated resources for mutation smoke checks.
2. In the Developer Portal: enable **Presence Intent**, keep **Message Content
   disabled**, use Guild Install, disable Public Bot and OAuth2 Code Grant, and
   leave the Interactions Endpoint URL empty (Gateway delivery). Invite with
   scopes `bot applications.commands`, `disable_guild_select=true` and
   permissions 19456 — never Administrator. The configured user must be in that
   guild and expose YouTube Music through rich presence; the bot cannot bypass
   activity privacy settings.
3. Before deploying or starting the bot, configure the private review channel,
   application-owned incoming webhook, Turnstile keys, and the Worker's secrets.
   Set `PORTFOLIO_API_URL` to the Worker’s origin without an API path. Retain
   the existing `CONTENT_WRITER_TOKEN` and supply the same value to the Worker
   and bot. Never expose it to the website. The content writer persists
   decisions before projecting them to KV; uncertain projections stay pending
   and cannot be rejected as though publication never happened.
4. Confirm that the existing R2 bucket can be bound without taking ownership of
   its lifecycle. Deploy the presence Worker
   (`bun run deploy:presence --profile admin --yes`) with the bot **stopped**.
   Preserve the existing `ContentWriter` namespace and storage. `PresenceDO` is
   the new SQLite-backed class; legacy KV presence data remains untouched.
5. Deploy the website once its public RPC answers, then start exactly one
   migrated bot. Keep the public composer disabled while verifying real
   submission and approval against isolated resources, followed by a separate
   submission and rejection. Verify restart recovery and unauthorized-user
   denial with Message Content disabled.
6. Only after those checks, set `PUBLIC_TURNSTILE_SITE_KEY` and
   `PUBLIC_NOTES_COMPOSER=enabled` for the website build. A site key alone does
   not enable submissions. Rotate the shared writer token in the Worker and bot
   together; failed operations during rotation must be retried after both sides
   use the new token.

Existing Alchemy resource identities, the `PORT_GITHUB_TOKEN` binding and the
GitHub cron are preserved by this work.

### Local verification

```sh
bun run test --run
bun run check
bun run --cwd apps/discord build
bun run --cwd apps/web build
docker build -f apps/discord/Dockerfile -t artisann-discord .
docker compose -f apps/discord/compose.yaml config --quiet
```

Local checks do not establish live Discord access, Turnstile configuration, or
actual Cloudflare hibernation. Use isolated KV/R2 resources for mutation checks.
Local verification does not authorize deployment or use of an exposed bot token.
