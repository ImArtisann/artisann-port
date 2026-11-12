# Artisann

My personal corner of the internet — projects, open-source work, what I’m
listening to, and a little about life in Dallas.

[Visit the portfolio](https://www.artisann.dev)

## Run the project locally

Use Bun `1.4.2` and install from the repository root with `bun install`. The
root catalog pins Effect `4.1.4`, Alchemy `2.0.0-beta.85`, Foldkit `0.170.0`,
and `@foldkit/vite-plugin` `0.29.0`. Cloudflare and GitHub providers come from
`@alchemy.run/cloudflare` and `@alchemy.run/github`. Domain uses
`@alchemy.run/domain`. Do not copy APIs from a newer Alchemy release.

The applications and shared packages have separate responsibilities.

- `apps/web` is the Foldkit portfolio. The build renders its initial HTML.
- `apps/jakes-cats` is the Foldkit Cats site. Its Worker renders each request
  with the existing visitor cookie.
- `apps/discord` is the owner-only bot, presence source, and website CMS.
- `packages/portfolio-domain` contains the pure Portfolio model for content,
  note decisions, and shared photo operations.
- `packages/cats-domain` contains the pure Cats model for hearts and comments.
- `packages/presence` contains the native Presence class host, PortfolioBackend,
  HTTP contracts, and storage adapters.
- `packages/assets` owns the R2 asset tooling and generated manifest.
- `packages/ui` retains shared React primitives. Neither Foldkit site uses
  React.

Use `bun run dev:web` for the portfolio alone. Its Vite proxy defaults to
`https://presence.artisann.dev`. `PUBLIC_PORTFOLIO_API_URL` selects another
validated API origin, including an explicitly port-qualified loopback origin.
This command does not start a local Portfolio backend or storage emulator. The
default proxy reads live galleries. Any authenticated write sent through that
proxy changes the configured backend's data.

The portfolio build requires a successful published content read. An unavailable
or invalid response fails the build instead of embedding seed data. Deploy the
backend before building the website during the cutover. CI builds through
`apps/web/scripts/with-seed-content.ts`, which serves the compiled seed document
on `127.0.0.1:4319`, so the CI check never reads the deployed backend.

`bun run dev` also starts the Discord bot. Do not use it for safe verification
or when another bot process is running. `bun run discord` loads `.env.discord`
and can change production content and photos. A missing Turnstile site key or
`PUBLIC_NOTES_COMPOSER` value other than `enabled` disables the note composer.

The website renders the Traks analytics snippet only when `TRAKS_SITE_KEY` is
set at build time. Leave it unset for untracked local builds.

## Deploy only with separate approval

Production deployment and data migration require separate approval. Local
implementation and verification do not authorize either action.

After explicit production approval, `bun run deploy --yes` deploys the presence
stack, portfolio website, and Cats stack with `--stage prod`. The Discord
container is separate. Coolify deploys it from GitHub webhooks. Follow the
release order below instead of treating this command as a migration.

The shared deployment token is minted by `stacks/github.ts` and stored by the
admin bootstrap, `bun run deploy:github`. A policy edit does not update an
already-stored Actions secret. Re-run the approved bootstrap to apply it. The
bootstrap also copies `WORKFLOW_SECRET_NAMES`, including registry tokens, Worker
secrets, and `TRAKS_SITE_KEY`, into Actions secrets. Values come from the shell
or `.env`, otherwise `.env.discord`. Missing values or disagreement between the
files fail the bootstrap. Never print these values.

Do not append `--help` or `--dry-run` to `bun run deploy`. Its task runs several
deployment commands, and extra arguments do not protect earlier commands. For an
approved plan, use `bun run plan`. For stack-specific previews, invoke
`deploy:presence`, `deploy:website`, or `deploy:cats` directly with `--dry-run`.
A preview is not permission to deploy.

## Update the domain list

Edit `DOMAINS` in `apps/web/src/view.ts` to change **Domain list**. The section
appears below **Personal records** in the desktop sidebar and mobile layout. The
domain list is static and is not managed by the Discord CMS.

## jakes.cat

`apps/jakes-cats` is a public, for-fun site: a visitor gets the `cats/` photos
from the shared R2 bucket in a shuffled, looping deck, swipes right to heart
one, sees the heart count, browses the most-hearted cats at `/top`, and leaves
anonymous comments on `/photos/<id>`. Visitors are identified by an HttpOnly
`jc_visitor` cookie, so a second heart from the same browser does not count. It
is its own Alchemy stack (`JakesCats`) with its own deploy command;
`bun run deploy` includes it, and `bun run deploy:cats --yes` still works
standalone.

In production the website Worker answers on both `jakes.cat` and
`www.jakes.cat`. The apex is canonical. `www` is a second managed custom domain
with its DNS record and edge certificate. Non-production stages bind neither
domain.

Comments are checked for local spam patterns and sent to profanity.dev for
moderation. Only the comment text is sent, not the visitor ID. Long comments use
overlapping requests of at most 35 words, with at most two in flight and an
eight-second total deadline. A flagged comment or unavailable moderation service
prevents the write.

`bun run dev:cats` starts the Cats Alchemy development stack. Do not use it as
an isolated mutation check. Its by-name `PHOTOS` binding can read the live R2
bucket, and uploads call the configured Portfolio photo owner. The default
`PORTFOLIO_ORIGIN` is `https://presence.artisann.dev`. Local D1 does not make
those photo writes local. Use isolated storage and an isolated Portfolio owner
before testing uploads or deletions.

The `JakesCats` stack contains separate `CatsBackend` and Foldkit `Website`
Workers. It keeps the `Likes` D1 resource and production database name
`jakes-cats-likes`, with migrations in `apps/jakes-cats/migrations`. D1 retains
the photo registry, source tables, migration journal, and Domain projections.
Cloudflare Images converts uploads, and an edge rate limiter protects hearts and
comments. The stack binds the existing assets bucket by name. It does not create
or delete that bucket.

Supply `CONTENT_WRITER_TOKEN`, `ASSETS_HOST`, `ASSETS_BUCKET_NAME`, and, when
needed, `PORTFOLIO_ORIGIN` to the deployment process. The writer token must
match PortfolioBackend. The Cloudflare deployment token needs D1 Write and
Workers Scripts Write at account level. Its `jakes.cat` zone permissions include
Zone Read, DNS Write, and Workers Routes Write.

### Uploading from an iPhone

`POST https://jakes.cat/api/photos` stores one photo in the `cats/` collection
(`?tag=life` targets the other collection). The permanent API accepts a raw
image body or a `multipart/form-data` file named `photo`. Cats converts the
image to WebP, sends it to Portfolio's shared photo owner, and registers it in
D1 with zero hearts. It requires `Authorization: Bearer <CONTENT_WRITER_TOKEN>`
and returns HTTP `201` with `{ key, url, tag, likes }`.

The 20 MiB file limit also applies to streams. Multipart bodies have a 64 KiB
framing allowance and are capped before parsing, including unused fields.
Uploads are create-only. Key collisions retry with a new ID, up to three
attempts. Other storage failures do not retry automatically. If D1 registration
fails, Cats asks the same photo owner to delete the new object with its expected
ETag. Failed or uncertain cleanup never becomes success. The object can remain
public. Inspect the `Upload rollback failed` log and reconcile its operation
before deciding whether to retry.

iOS Shortcut recipe (Share Sheet → image):

1. _Receive_ **Images** from **Share Sheet**.
2. **Convert Image** to **JPEG** (Cloudflare Images does not accept HEIC).
3. **Get Contents of URL** — Method `POST`, URL `https://jakes.cat/api/photos`,
   Headers `Authorization` = `Bearer <token>`, Request Body **File** = the
   converted image.
4. Optional: **Show Result** to see the returned URL.

The token is shared by the presence Worker, the cats Worker, the Discord bot,
and every installed upload Shortcut. Rotate all copies using the
[credential rotation procedure](#credential-rotation); updating the bot and
presence Worker alone does not revoke access to the cats upload endpoint.

## Use the public HTTP contracts

Portfolio clients use same-origin `GET /api/content`, `GET /api/photos`,
`GET /api/github`, and `GET /api/weather`. Photos require `tag=life` or
`tag=cats`, with an optional pagination cursor. Notes use `POST /api/notes`. The
browser keeps the native `/presence` WebSocket and project OG-image routes.

Cats uses `GET /api/deck`, `GET /api/top`, `GET /api/photo/:id`,
`POST /api/hearts`, and `POST /api/comments`. Its visitor cookie stays
`jc_visitor`. Invalid or missing managed photo IDs return `404`. Public
responses never include visitor IDs.

Both sites use Foldkit resources and Domain watches at `/api/domain`. Portfolio
selects `PublishedContent`, keyed `site-content`, with `{ content, revision }`.
Cats selects `PhotoCounts`, keyed by managed photo key, with `{ likes }`.
Neither endpoint exposes raw aggregate state or privileged commands. Contracts
are defined in `packages/portfolio-domain/src/portfolio.api.ts`,
`packages/cats-domain/src/cats.api.ts`, `packages/presence/src/http-server.ts`,
and `apps/jakes-cats/src/server/http.ts`.

## Discord bot operations

The bot in `apps/discord` is private to one owner in one guild. It uses typed
HTTP clients to publish presence, manage photos, edit content, and moderate
notes. Portfolio owns content and photo operations. The native `PresenceDO`
keeps transient presence and hibernatable WebSockets outside Domain events.
Approve/Reject buttons remain in the existing private Discord review channel.
Pending and rejected NOTE text stays in that Discord payload, not Domain events
or public responses. Approved text may enter published content. Existing review
controls and their identifiers remain valid. The bot has no HTTP port or local
durable volume.

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

Set `PORTFOLIO_API_URL=https://presence.artisann.dev` in `.env.discord`. The bot
has no default API origin. Supply the same nonempty `CONTENT_WRITER_TOKEN` to
the Worker and bot. The bot does not need a Cloudflare management API token,
account ID, KV namespace ID, or bucket name.

PortfolioBackend requires `DISCORD_NOTES_WEBHOOK_URL`, `TURNSTILE_SECRET_KEY`,
and `CONTENT_WRITER_TOKEN`. The native Presence host keeps `PORT_GITHUB_TOKEN`
for its existing GitHub cron. Supply these to the Alchemy deployment process.
The bot's `.env.discord` is not loaded by Worker deployment. Set
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
2. **Writer token** — `CONTENT_WRITER_TOKEN` authorizes private Portfolio HTTP
   routes, migration controls on both models, and the Cats upload endpoint. Keep
   it in both backends, the bot runtime, and the owner's upload Shortcuts. Never
   send it to browser code. To rotate it:
    - Pause uploads and stop the bot. Replace the token in the Alchemy process
      environment and saved deployment secrets, including GitHub Actions.
      Otherwise, a later deployment can restore the old value.
    - Deploy both backend stacks with the replacement:
      `bun run deploy:presence --yes` and `bun run deploy:cats --yes`. A failed
      deployment leaves that backend's rotation unverified.
    - Replace the bot's `.env.discord` or container runtime value and the
      `Authorization` header in every installed Shortcut. Restart the bot with
      the new environment.
    - Verify that the Portfolio writer routes, both migration APIs, and Cats
      upload endpoint reject the old token and accept the replacement. Missing
      or mismatched tokens refuse writes. Retry failed operations only after all
      consumers use the replacement. Do not substitute a Cloudflare management
      token.
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

Bot photos use bounded binary HTTP requests to Portfolio's photo owner. Neither
bot nor Cats uses the Cloudflare management API to mutate photos.

Photo commands accept regular and ephemeral Discord attachments. The bot
downloads the supplied signed attachment URL, normalizes the image to WebP, and
uploads it to R2. The private command response displays the R2-hosted image, so
its preview does not depend on the temporary Discord attachment URL.

Project previews use each app’s Open Graph image. The app add/edit modal accepts
optional approved image hostnames, one per line. Blank input clears these
approvals. Projects do not require screenshot uploads. Use `/experience` and
`/facts` to add, edit, or remove work history and personal facts.

Portfolio content uses the public `PublishedContent` Domain watch, keyed
`site-content`. HTTP content and photo reads also refresh every 60 seconds.
GitHub and weather refresh every 15 minutes. Failed connections retain the
current content. Cats watches the public `PhotoCounts` view for the current
photo. Neither public Domain API exposes commands, raw aggregate state, private
decisions, or visitor IDs. Mutation routes enforce their own authorization,
moderation, and rate limits before calling internal commands.

Owned clients use `/api` HTTP contracts and `/api/domain` watches. The old
`/rpc`, `/rpc/writer`, `/rpc/notes`, and TanStack server-function transports are
removed. Refresh pre-cutover browser tabs after release. Public JSON responses
use `Cache-Control: no-store`. Images keep their separate cache policy. Photo
listings use R2, which remains authoritative for existence.

Presence uses a native `/presence` WebSocket, not polling. Failed connections
retain the last snapshot and reconnect with delays from one to thirty seconds. A
valid snapshot resets that delay. Stale observations become unavailable while
the last song remains visible. Keep the bot and backend assets hostnames
consistent.

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

## Release the online migration

Complete these release gates before production handoff.

1. Obtain explicit approval for production deployment and each model's authority
   handoff. Keep the existing writer token unless a separate rotation is
   approved. Do not start Discord or send mutation smoke tests to live data.
2. Complete the local checks below and mutation checks against isolated storage.
   Verify submission, approval, rejection, restart recovery, and unauthorized
   denial there. Keep pending and rejected text in Discord only.
3. Check the approved stack previews against existing resource identities.
   Preserve `ArtisannPortfolioPresence/Presence`, both native DO classes and
   namespaces, KV `Snapshots`, and `JakesCats/Likes`. The production D1 name
   remains `jakes-cats-likes`. Preserve the assets bucket, object keys, public
   URLs, visitor cookies, timestamps, and decisions. Never reset, destroy, or
   recreate storage to make an upgrade pass.
4. Verify secrets and bindings without printing their values. PortfolioBackend
   needs the legacy content and native presence namespaces plus the existing R2
   bucket. The native `Presence` Worker remains the raw class host and forwards
   other requests to PortfolioBackend. Preserve `PORT_GITHUB_TOKEN` and its
   cron. CatsBackend needs the existing D1, its R2 binding for reads, Images,
   rate limiter, and configured Portfolio photo owner.
5. Deploy the backend stacks with `bun run deploy:presence --yes` and
   `bun run deploy:cats --yes`. These commands install the capture-capable
   adapters and Cats D1 migrations. Confirm capture is installed before taking
   baselines. Source authority remains active during import.
6. Deploy the portfolio with `bun run deploy:website --yes`. Cats' stack deploys
   its Foldkit website and backend together. Deploy the HTTP-client bot
   separately through Coolify. Replace the old process with exactly one new
   process. Do not leave an old RPC bot running. Do not stop all writes for the
   import. Existing clients can receive brief retryable errors during release.
   Refresh pre-cutover browser tabs instead of restoring the removed RPC routes.
   The portfolio's native `PORTFOLIO` service binding references
   `PortfolioBackend` in `ArtisannPortfolioPresence` at the same stage. Its
   website does not receive a writer secret.
7. Run the independent Portfolio and Cats procedures below. Page through
   baseline and captured changes until the exact convergence checks pass. Do not
   use photo counts alone as evidence. Complete each fenced handoff promptly.
   Retry uncertain operations with the same identities.
8. Confirm each model's authority and publication status before accepting the
   release. Check both public sites, their initial HTML, live views, and native
   presence. Verify the existing Discord review controls with approved isolated
   checks, not newly fabricated production submissions.
9. After handoff, recover forward only. Do not restore the old writer or source
   database as authority. There is no reverse replication of new Domain writes.

Keep the existing bot installation controls. Enable **Presence Intent**, keep
**Message Content** disabled, use Guild Install, and leave the Interactions
Endpoint URL empty. Use `bot applications.commands`,
`disable_guild_select=true`, and permissions `19456`, never Administrator. The
configured user must expose YouTube Music through rich presence. The bot cannot
bypass activity privacy.

The private review webhook must remain application-owned and attached to the
configured private channel. The composer still requires both
`PUBLIC_TURNSTILE_SITE_KEY` and `PUBLIC_NOTES_COMPOSER=enabled`. Do not weaken
origin checks, Turnstile, moderation, or limits during migration.

### Call private migration controls

Use the existing trusted operator HTTP client against each configured origin.
Inject `Authorization: Bearer <CONTENT_WRITER_TOKEN>` from protected runtime
configuration. Do not put the token in a URL, public file, shell trace, or log.
Use `Content-Type: application/json` for JSON bodies.

Portfolio controls use the Portfolio API origin, normally
`https://presence.artisann.dev`. Cats controls use its API origin, normally
`https://jakes.cat`. Identical paths do not select the same model. There is no
root migration script. `bun run deploy` does not call these routes.

Status and exports are private. Portfolio snapshots contain content and private
decision IDs. Cats exports contain visitor IDs and comments. Keep backups,
exports, and responses in approved private storage, not this public repository
or deployment logs.

### Migrate Portfolio content

The source journal and baseline are defined in
`packages/presence/src/content-migration-source.ts`. The Domain importer is in
`content-migration-service.ts`. Use one stable `epoch` for the migration. Do not
change it to bypass a conflict.

1. Send `POST /api/migration/prepare` with
   `{ "epoch": "<stable-private-migration-id>" }`. The source transaction
   records its baseline and enables capture before later writes can commit.
   Repeating the same epoch returns the existing baseline.
2. Send `POST /api/migration/import` with `{ "take": 100 }`. `take` accepts `1`
   through `100` and defaults to `100`. Repeat until `GET /api/migration/status`
   reports `converged: true`. Imports retain content revisions, note IDs,
   timestamps, and rejected/deleted decision IDs. Stable epoch and sequence
   command IDs make retries idempotent.
3. Keep source writes enabled during catch-up. Convergence requires the same
   source epoch, sequence, content, revision, publication revision, and decision
   sets. An intervening source write requires another import page.
4. Send `POST /api/migration/handoff` after convergence. Handoff fences the
   exact source sequence, verifies the frozen snapshot, activates Domain, and
   marks the source complete. It refuses a stale sequence or unpublished source
   revision. It does not acknowledge two independent writers.
5. Inspect status after every uncertain handoff response. Retry the same handoff
   to complete an already-activated target. A `202` means publication is still
   pending. `503`, a typed error, or a timeout never proves success. Accept
   completion only after the source is in `domain` mode, the target is active,
   and its publication revision has caught up.

`POST /api/migration/export` accepts `{ "after": 0, "take": 100 }` for captured
source entries. Advance `after` to the last returned sequence. Keep every export
private. Do not treat an export of changes as a replacement for the baseline.

Before invoking handoff, you can abandon the Portfolio attempt by leaving the
source in `legacy` mode and stopping imports. Do not erase its journal or change
the epoch. There is no standalone Portfolio `fence` or `abort` HTTP route.
Handoff itself drains pending source publication and performs the fence. Once
that fence has happened, recovery is forward only, even if activation or the
final response fails. Inspect status and retry handoff. Do not reopen the legacy
writer.

### Migrate Cats hearts and comments

`apps/jakes-cats/migrations/0004_domain_online.sql` installs source capture and
fencing triggers before baseline preparation. Source heart and comment tables
are append-only. Do not bypass those triggers with manual repair writes.

1. Send `POST /api/migration/prepare`. The stored high-water marks delimit the
   baseline while new source writes continue. Repeating preparation does not
   move those marks.
2. Send `POST /api/migration/import` with `{ "phase": "hearts", "take": 100 }`
   until `hearts_cursor >= hearts_high`. Repeat with `"phase": "comments"` until
   `comments_cursor >= comments_high`. `take` accepts `1` through `100`.
3. Import `"phase": "changes"` repeatedly. Check `GET /api/migration/status`.
   Before fencing, require `baselineComplete: true`, caught-up `checkpoint`, and
   `differences: 0`. Source writes can advance `capturedThrough` during this
   check. Re-import changes when they do.
4. Send `POST /api/migration/fence`. The D1 statement serializes with source
   writes and records `fence_seq`. Requests that reach a fenced source fail
   retryably instead of reporting an unrecorded write as accepted.
5. Import `"phase": "changes"` until `checkpoint >= fence_seq`. Require
   `baselineComplete: true` and `differences: 0` again. The comparison checks
   exact rows both ways, including visitor identities, comment IDs, text, and
   timestamps. Replaying a fact cannot add a second heart.
6. Send `POST /api/migration/handoff`. Confirm `mode: "domain"` through status.
   Repeating handoff after success returns the existing status. Source tables
   remain fenced. New mutations use Domain, and D1 holds its projections.
7. To abandon a fenced attempt before handoff, send `POST /api/migration/abort`.
   It restores source mode without deleting capture or import progress. After
   `mode: "domain"`, abort is rejected. Recover forward.

`POST /api/migration/export` accepts `phase`, `after`, `take`, and optional
`through`. Valid phases are `hearts`, `comments`, and `changes`. Start `after`
at `0`. Keep the returned `through` fixed while paging, advance to the returned
`cursor`, and stop when `complete` is true. Keep the facts private. Counts and
logs cannot reconstruct their identities.

## Recover a shared photo operation

Both backends and the bot use Portfolio's single photo mutation owner. R2 still
determines whether an image exists. Existing image keys and URLs do not change.
Domain stores operation evidence, not the image bytes.

Use these bearer-gated owner routes only through trusted server configuration.
Authorization checks the raw header before the body is read.

- `POST /api/writer/photos?key=<managed-key>&tag=life|cats` accepts WebP bytes,
  up to 32 MiB. Supply a stable `x-photo-operation-id`. `x-photo-writer` is
  `owner`, `discord`, or `cats`, and defaults to `owner`. `If-None-Match: *`
  selects create-only. Without it, the request is a replacement. The `201`
  receipt contains `key`, `url`, `tag`, `operationId`, and `etag`.
- `DELETE /api/writer/photos?key=<managed-key>` uses the same operation-ID
  header. Optional `If-Match` supplies the expected ETag. A successful receipt
  contains `key` and `operationId`.
- `POST /api/writer/photos/reconcile` accepts `PhotoReconciliationRequest` from
  `packages/presence/src/photos-service.ts`. It has an 8 KiB JSON cap. Only this
  owner control can inspect or authorize manual recovery.

Managed keys match `^(life|cats)/[0-9]{17,20}\.webp$`. Operation IDs match
`^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$`. Reusing an ID with a different request
is a conflict. A retry must retain the key, operation ID, writer, mode, and
bytes. Do not create a new operation to bypass an uncertain previous one. An
identical retry never executes an uncertain operation again before the owner's
`resume`. Until then it can only complete an upload that R2 metadata confirms,
or a deletion whose object is already absent.

Follow this sequence after a typed uncertain result, timeout, or failed cleanup.

1. Send `{ "action": "inspect", "key": "<key>", "operationId": "<id>" }` to the
   reconcile route. Record `generation`, `storageEtag`, `status`, `requestKind`,
   `evidence`, and `outcome` in private operator state.
2. For every mutating reconciliation request, include `expectedGeneration` from
   inspection and `expectedEtag` equal to its `storageEtag`, including `null`
   for absence. Changed evidence or generation is a conflict.
3. If `evidence` is `upload-confirmed`, use `"action": "recover-confirmed"`.
   Matching R2 operation metadata and byte digest can confirm that upload. Mere
   object presence cannot.
4. Before `resume`, `abort`, or `confirm-deleted`, confirm that the original
   invocation AND all its outstanding R2 calls have stopped. A client timeout,
   elapsed time, or absent object does not establish this. If you cannot confirm
   both conditions, leave the operation uncertain and do not release ownership.
5. Only after that confirmation, include
   `"confirmation": "original-writer-stopped"` with one of those actions. This
   literal records your assertion. The route cannot prove it for you. `resume`
   advances the generation and marks the operation `resumable`. The next
   identical retry then executes the original request again. `abort` ends the
   workflow without undoing an R2 write. It refuses an upload already confirmed
   by metadata. `confirm-deleted` requires a Delete operation and current object
   absence.
6. Inspect again and check the typed outcome. `unknown` is not success. A
   `PhotoMutationError`, `503`, or timeout can leave public storage changed. Do
   not claim deletion, completion, or rollback without the required evidence.

Native R2 has no atomic conditional delete in this adapter. An external writer
can replace an object between `head` and `delete`. Domain generations cannot
fence that external write. Coordinate external R2 writers before deletion or
manual recovery. The ETag check does not remove this platform limit.

## Verify locally without production mutations

Run checks from the root. The Foldkit portfolio uses `vp check`. It no longer
needs `astro check` or a separate TypeScript 6 requirement. These commands are
verification instructions, not recorded pass results.

```sh
bun run test --run
bun run check
bun run --cwd apps/discord build
bun run --cwd apps/web build
bun run --cwd apps/jakes-cats build
docker build -f apps/discord/Dockerfile -t artisann-discord .
docker compose -f apps/discord/compose.yaml config --quiet
```

Use `bun run test --run <path>` for a scoped check. Confirm that the runner
reports the expected test files. `passWithNoTests` can otherwise hide a bad
path. Do not run the bot as a test. Do not expand compose configuration into
logs. Portfolio builds read the configured API, so isolated builds need an
isolated read endpoint. Browser checks must use headless `agent-browser` with a
unique session and isolated mutation resources.

Local checks do not establish live Discord access, Turnstile configuration,
Cloudflare hibernation, deployed service bindings, or production convergence.
Foldkit's experimental server rendering and hydration remain accepted risks. No
local result authorizes deployment, production migration, or use of an exposed
bot token.
