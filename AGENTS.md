# Repository Guidelines

Personal portfolio at [www.artisann.dev](https://www.artisann.dev). The
owner-only Discord bot is the CMS and presence source. A Cloudflare Worker is
the API and authority. The Astro site is a read-only projection.

`README.md` is the operational source of truth for Discord, secrets, and
rollout. Read it before you change `apps/discord` or `packages/presence`.

## Project Overview

Bun workspace (`apps/*`, `packages/*`) with catalog-pinned dependencies.

| Deployable          | Role                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| `apps/web`          | Static Astro site. Build-time content read, React islands at runtime.        |
| `apps/discord`      | Private dfx bot. Only writer of presence and site content.                   |
| `packages/presence` | Worker: public RPC, writer RPC, notes, WebSocket presence, OG proxy.         |
| `packages/assets`   | R2 bucket, content-addressed image manifest, upload tooling.                 |
| `packages/ui`       | Shared React/shadcn primitives. The site does not depend on them for layout. |

Local `bun run dev` talks to **production** `https://presence.artisann.dev`. It
does not start a local Worker, KV, Durable Object, or R2 emulator. Discord photo
commands mutate the live bucket.

## Architecture & Data Flow

Schema-first contracts in `packages/presence` are shared by the browser, the
Worker, and the bot. Encoded shape equals decoded shape: documents travel as
plain JSON.

```mermaid
graph LR
  Bot[apps/discord] -->|writer RPC Bearer| W[presence Worker]
  W --> CW[ContentWriter DO]
  W --> PD[PresenceDO]
  CW -->|projection| KV[(PRESENCE_KV)]
  W -->|native binding| R2[(assets R2)]
  Site[apps/web islands] -->|ndjson /rpc| W
  Site -->|wss /presence| PD
  Visitor -->|/rpc/notes Turnstile| W
  W -->|webhook + buttons| Review[Discord review channel]
  Review -->|Approve/Reject| Bot
```

Worker surfaces (`packages/presence/src/worker-handlers.ts`):

| Path                      | Auth                                                                    | Wire                              | Purpose                                                   |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `/rpc`                    | CORS `*`                                                                | ndjson                            | `content.get`, `photos.list`, `github.get`, `weather.get` |
| `/rpc/writer`             | `Authorization: Bearer CONTENT_WRITER_TOKEN` on the **raw HTTP header** | schema-binary, 32 MiB             | presence, content apply, photo upload/delete              |
| `/rpc/notes`              | origin allow-list + Turnstile + edge ratelimit                          | ndjson                            | `notes.submit`                                            |
| `/presence`               | none                                                                    | WebSocket, one snapshot per frame | live presence                                             |
| `/projects/<id>/og-image` | none                                                                    | image                             | OG preview, `caches.default`                              |

**Presence.** Gateway events → ordered reducer (`apps/discord/src/presence.ts`)
→ `presence.publish` → `PresenceDO` → hibernatable sockets. Stale after 150s
(`PRESENCE_STALE_AFTER_MS`). Browser: one socket per endpoint and Atom registry;
reconnect 1s→30s.

**CMS.** Slash commands → `content.apply` → `ContentWriter` DO (revision CAS) →
KV projection. KV `site-content` is a read-only mirror. While
`publishedRevision < revision`, callers get 503.

**Photos.** Discord attachment → sharp WebP → binary writer RPC → native R2
`put`. Public list is R2 `list()`, no index. Images live on
`assets.artisann.dev`.

**Notes.** Turnstile → Worker webhook with Approve/Reject → bot re-fetches the
source message → `content.apply`. Rejected text never reaches site content.

**GitHub.** Worker cron `*/15` → GraphQL → KV. Failures keep the previous
calendar.

Three Alchemy stacks, plus a one-shot GitHub bootstrap:

- `alchemy.run.ts` — Astro site, prod-only apex→www redirect.
- `packages/presence/alchemy.run.ts` — Worker, KV, DOs, R2 binding by name.
- `packages/assets/alchemy.run.ts` — R2 bucket + custom domain.
- `stacks/github.ts` — repo settings and the scoped Cloudflare token.

The presence stack **binds** the assets bucket by name. It must not provision
it. Coolify deploys the Discord container; `bun run deploy` does not.

## Key Directories

| Path                                | Purpose                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/pages`                | One page: `index.astro`.                                                                                                                                                                                 |
| `apps/web/src/components/portfolio` | React islands (`client:load`).                                                                                                                                                                           |
| `apps/web/src/lib`                  | RPC atoms, WebSocket presence, build-time content, Atom registry.                                                                                                                                        |
| `apps/discord/src`                  | One file per concern: `main`, `config`, `commands`, `cms`, `photos`, `notes`, `presence`, `*-client`.                                                                                                    |
| `packages/presence/src`             | Browser-safe **contracts** (`schema`, `content`, `rpc`, …); **services** (`*-service.ts`); **native adapters** (`worker-handlers`, `rpc-server`, `durable-objects`); **DO controllers** (`*-object.ts`). |
| `packages/assets`                   | Manifest, `images/`, R2 upload scripts.                                                                                                                                                                  |
| `packages/ui`                       | shadcn primitives and `cn`.                                                                                                                                                                              |
| `tools/oxlint/{effect,anti-slop}`   | Local oxlint plugins. Do not lint this tree.                                                                                                                                                             |
| `stacks/`                           | Alchemy stacks outside the main deploy graph.                                                                                                                                                            |

Contract modules under `packages/presence/src` must stay free of env reads,
credentials, and Worker-only imports. A Node/Workers import in a contract file
breaks the browser bundle.

## Development Commands

Run from the repository root. Package manager is Bun `1.4.2`.

```sh
bun install                         # prepare: lefthook + effect-tsgo patch
bun run dev                         # Astro + Discord against live API
bun run dev:web                     # website only (--no-env-file)
bun run discord                     # bot via .env.discord
bun run check                       # vp check + astro check
bun run lint                        # vp lint
bun run format                      # vp fmt
bun run test                        # vp test (single run, not watch)
bun run test --run path/to/file.ts  # scoped
bun run build                       # vp run -r build (web + discord + assets)
```

Deploy (production stage is mandatory):

```sh
bun run deploy --yes                # presence then website, --stage prod
bun run deploy:presence --yes
bun run deploy:website --yes
bun run plan                        # alchemy plan alchemy.run.ts
bun run login                       # GitHub stack profile admin
bun run deploy:github
```

Assets:

```sh
bun run --cwd packages/assets generate
bun run --cwd packages/assets verify      # stale-manifest check, no rewrite
bun run --cwd packages/assets upload:plan
bun run --cwd packages/assets upload
```

Discord image (context = repo root):

```sh
docker build -f apps/discord/Dockerfile -t artisann-discord .
docker compose -f apps/discord/compose.yaml config --quiet
```

Local verification (`README.md`):

```sh
bun run test --run
bun run check
bun run --cwd apps/discord build
bun run --cwd apps/web build
docker build -f apps/discord/Dockerfile -t artisann-discord .
docker compose -f apps/discord/compose.yaml config --quiet
```

`vp check` does not typecheck Astro. Always use `bun run check`.

`packages/presence`'s own `deploy` script has **no** `--stage prod`. Do not use
it to ship production.

## Code Conventions & Common Patterns

### Format and lint

Config lives only in `vite.config.ts`. No Prettier, ESLint, or EditorConfig.

- 100 columns, 4-space indent, semicolons, double quotes.
- Markdown: 80 columns, `proseWrap: always`.
- Type-aware oxlint (`@effect/tsgo/oxlint-presets` plus
  `tools/oxlint/{anti-slop,effect}`).
- Type assertions need a `// SAFETY:` comment.
- Relative imports keep the `.ts` / `.tsx` extension.

Rules that reject otherwise-reasonable code: `no-direct-fetch`,
`no-module-mocking`, `no-unknown-parameters` / `-returns` / `-type-aliases`,
`no-runtime-typeof`, `no-nested-layer-provide`, `no-cascading-layer-provide`,
`no-silent-error-swallow`, `no-service-option`, `prefer-effect-match`,
`prefer-option-from-nullable`.

In React event/animation handlers, prefix with
`// oxlint-disable-next-line effecttsgo/async-function` (see
`visitor-notes.tsx`, `photo-gallery.tsx`).

### Naming

- Files: kebab-case. Suffixes: `*-service.ts` (Effect service + `Live` layer),
  `*-object.ts` (DO controller), `*-client.ts` (RPC wrapper), `*-schema.ts`,
  `config.ts` (browser-safe constants), `*.gen.ts` (**generated, never edit**).
- Layers: `PresenceLive`, `BotConfigLive`. Bindings/config: `*Binding`,
  `*Config`.
- Schema twin:
  `export const X = Schema.Struct({...}); export type X = typeof X.Type;`
- Caps: `MAX_*`, `SCREAMING_SNAKE_CASE`.

### Effect, errors, async

Effect **4.0.0-rc.112**. Import `effect/unstable/*` (`rpc`, `http`,
`reactivity`, `socket`). Do not use Effect 3 paths.

- Named functions: `Effect.fn("Name")`. Service methods: `Effect.withSpan`.
- No `fetch`. Use `HttpClient` / `FetchHttpClient.layer`.
- Domain errors are `Schema.TaggedError` (`api-errors.ts` and local siblings).
  Never leak a cause across RPC. Sanitize before log or Discord
  (`rpcStorageError`, `describeError`).
- Untrusted input decodes to `null` / `Option.none()`, it does not throw.
- Corrupt persisted data **fails the read**. It does not fall back to defaults.
- Bound concurrency with `Semaphore`. Timeouts at every I/O edge (bot RPC 15s,
  interaction jobs 120s).
- Supervise long fibers: log the cause, retry on a bounded cadence.

### Dependency injection

Capabilities are Layers. Domain logic is a service that requires them. One
composition root provides everything.

- Worker: `makeWorkerLayer(env)` in `worker-handlers.ts`. Handlers contain no
  storage implementation.
- Bot: `runtimeLayer(options)` in `apps/discord/src/main.ts` — one flat named
  graph with injectable overrides.
- Bindings are structural (`PhotosR2Binding`, `DurableObjectStorageLike`) so
  domain code does not import `@cloudflare/workers-types`.

### State

- **Authority:** `ContentWriter` DO owns site content (CAS, `dirty`,
  `publishedRevision`, alarms). `PresenceDO` owns the snapshot. KV is a
  projection.
- **Bot:** in-process `Ref` behind a semaphore; 2s flush, 60s confirmation.
- **Browser:** one `AtomRegistry` per page (`SharedAtomRegistry`,
  `defaultIdleTTL: 0`). Atoms are `Atom.family` keyed by endpoint so islands
  share one socket/query.

### Load-bearing patterns

1. **One writer per resource.** Single-writer for the bot is operational, not
   Compose-enforced. Check `docker ps` / `pgrep -f discord` before start.
2. **Deferred Discord interactions.** ACK within 3s. Authorize → validate →
   `queueJob` → return deferred. `makePostHandler` forks into the app scope
   **after** ACK. Never fork long work inside a handler (`interaction-jobs.ts`).
3. **Read-then-change-function.** `BotContentClient.updateContent` takes
   `(current) => Result<SiteContent, …>`, re-reads first, retries `conflict`
   twice. Do not write a document from a stale read.
4. **Uncertainty is never success.** Projection lag is 503, not a silent OK.
   `reject` of an already-published id is `already-approved`.
5. **Fail closed** at the boundary: custom-id grammars (`cms:`, `photos:`,
   `notes:`), origin/host allow-lists, WebP magic bytes, streamed body caps (32
   MiB / 16 KiB / 8 KiB).
6. **Redact structurally.** `Config.redacted`. Startup errors name the variable,
   never the value.
7. **Adding an RPC.** Touch `rpc.ts`, the handler layer in `rpc-server.ts`, and
   `rpc-transport.ts` if serialization changes. `Uint8Array` belongs on the
   writer route only (schema-binary). Public routes are ndjson.
8. **Both DO classes** must stay exported from `packages/presence/src/worker.ts`
   (Alchemy `main`).
9. RPC responses are `Cache-Control: no-store`. Do not copy image cache policy
   onto RPC.

### Web UI

Tailwind v4 utilities. Preserve `data-design-node` / `data-portfolio-section` on
`apps/web/src/pages/index.astro`. Turnstile script must be a real HTML tag
(`<script is:inline>` to
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`).
Dynamic injection fails with “Could not find Turnscript tag.”

## Important Files

**Contracts (read first)**

- `packages/presence/src/rpc.ts` — API surface.
- `packages/presence/src/schema.ts` — presence snapshot.
- `packages/presence/src/content.ts` — site document, limits, defaults.
- `packages/presence/src/content-writer.ts` — authoring protocol.
- `packages/presence/src/config.ts` — paths, cron, staleness, allowed hosts.

**Authority**

- `packages/presence/src/content-writer-object.ts`
- `packages/presence/src/presence-object.ts`
- `packages/presence/src/worker-handlers.ts`, `rpc-server.ts`,
  `durable-objects.ts`

**Composition roots**

- `apps/discord/src/main.ts`, `rpc-client.ts`, `content-client.ts`
- `apps/web/src/lib/rpc-client.ts`, `presence-client.ts`, `atom-registry.tsx`,
  `site-content.ts`

**Infra**

- `package.json`, `vite.config.ts`, `lefthook.yaml`
- `alchemy.run.ts`, `packages/presence/alchemy.run.ts`,
  `packages/assets/alchemy.run.ts`, `stacks/github.ts`
- `patches/@distilled.cloud%2Fcore@1.0.0-rc.8.patch` — keep `patches/` in every
  install context (Docker copies it before `bun install`).

**Generated**

- `packages/assets/src/manifest.gen.ts` —
  `bun run --cwd packages/assets generate`. Root `bun run build` rewrites it.

## Runtime/Tooling Preferences

- **Bun 1.4.2** is the runtime and runner. Workers run on workerd. CI also
  installs Node 24 for setup only (`engines.node >= 22.12.0`).
- Never hand-symlink dependencies. `bun install` already links workspaces.
- Shared versions go in the root `catalog` block. Packages reference
  `"catalog:"`. Do not pin a second copy.
- **vite-plus (`vp`)** owns run, lint, format, and test. Do not add ESLint,
  Prettier, Vitest, or `tsc` scripts.
- `bun --no-env-file` is deliberate on `dev:web`, `discord`, and the Docker
  entrypoint. Root `.env` holds Cloudflare/GitHub credentials. The bot never
  reads the repo `.env`; it uses `.env.discord` or compose `env_file`.
- **TypeScript is dual-versioned.** Root is 7.0.2 (`@effect/tsgo`). `apps/web`
  pins TypeScript 6 because `astro check` has no TS 7 programmatic API. Do not
  unify them.
- `prepare` runs `effect-tsgo patch --typescript --oxlint`. Dev installs must
  not use `--ignore-scripts`. Docker/CI Discord image **does** use
  `--ignore-scripts` on purpose.
- Private registries: `.npmrc` needs `HUGE_ICONS_TOKEN` / `MOTION_TOKEN` for a
  full install. Discord Docker uses `--filter @artisann-port/discord` so those
  tokens are not required.
- `sharp` is `--external` in the bot bundle. Build the image on the target
  architecture. Do not copy macOS `node_modules`.
- Secrets are runtime-only. Never a build `ARG`/`ENV`. Do not print secret
  values or expanded compose config.
- Design files: `tools/design-files/landing.pen` is encrypted. Use Pencil MCP
  tools only. Do not `Read`/`Grep` `.pen` files.
- Long-running dev servers inside a git worktree: follow the Herdr coordination
  policy when `HERDR_ENV=1`. Install, edit, build, and test do not use Herdr.

Prod Alchemy resources and domains exist only with `--stage prod`. Use `--yes`
for non-interactive deploys. CI deploys after a successful `main` push
(`cloudflare-production` concurrency, skip superseded SHAs). There is no
`workflow_dispatch`.

## Testing & QA

Single runner: Vitest inside vite-plus. Import from `vite-plus/test`. Config is
the root `vite.config.ts` `test` block (`passWithNoTests: true`). No
`vitest.config`, no Jest, no `bun:test`, no per-package `test` script.

```sh
bun run test                                          # whole workspace
bun run test --run packages/presence/__tests__/rpc.test.ts
bun x --no-install vp test watch                      # watch
```

Always run from the **repo root**. `bun run --cwd apps/web test` fails.
`passWithNoTests: true` exits 0 on a typo'd path — check `Test Files N passed`.

Tests live in `__tests__/` only (17 files):

- `packages/presence/__tests__/` — RPC wire, DO controllers, schemas.
- `apps/discord/__tests__/` — commands, CMS, notes, content-client, presence,
  config.
- `apps/web/__tests__/` — presence socket, Atom SSR lifetime.

Place new tests under `__tests__/`. A `src/*.test.ts` file misses the lint
override for `effecttsgo/async-function`, `global-date`, and `new-promise`.

**Fakes, not mocks.** `anti-slop/no-module-mocking` errors on `vi.mock`. Inject
complete Effect Layers (unused members `Effect.die`), scripted `HttpClient`
under real `dfx`/`RpcTest`, or hand-written doubles (`MemoryStorage`,
`LocalSocket`). `vi.stubGlobal` and fake timers are fine. No sleeps: use
`Deferred` gates and `TestClock`.

Web tests use `react-dom/server` `renderToString` and a real `AtomRegistry`. No
jsdom, no Testing Library.

No coverage thresholds. Pre-commit formats and lints only. CI: `check` → `test`
→ `build`.

Untested: `packages/ui`, `packages/assets` (use `verify`), Alchemy stacks, most
Astro components. Local tests do not prove live Discord, Turnstile, or Worker
hibernation. Use isolated KV/R2 for mutation smoke checks.

Read before changing the matching area:

- `packages/presence/__tests__/rpc.test.ts`
- `apps/discord/__tests__/content-client.test.ts`
- `apps/discord/__tests__/notes.test.ts`
- `packages/presence/__tests__/content-writer-object.test.ts`
- `apps/web/__tests__/presence-client.test.ts`
