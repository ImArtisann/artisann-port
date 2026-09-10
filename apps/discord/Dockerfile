# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/discord/Dockerfile -t artisann-discord .
#
# The image carries no configuration: all variables come from the run-time
# environment (compose env_file). No secret is passed as ARG or ENV, and root
# .dockerignore keeps every .env*/.npmrc file, .git and host node_modules out of
# the context.
#
# oven/bun:1.4.2 matches the repository's packageManager pin and publishes
# linux/amd64 and linux/arm64. Build on the host that will run the container so
# sharp's native packages match that architecture; never copy host (macOS)
# node_modules into the image.

FROM oven/bun:1.4.2 AS manifests
WORKDIR /app
# Manifests only, so dependency layers cache until they change. Every workspace
# manifest keeps its original relative path, which the lockfile resolves against.
COPY package.json bun.lock ./
COPY patches patches
COPY apps/discord/package.json apps/discord/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/presence/package.json packages/presence/package.json
COPY packages/assets/package.json packages/assets/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json

# Install only this app's dependency graph (dev dependencies included) for
# bundling. Filtering also avoids installing unrelated workspaces whose
# packages come from private registries (for example apps/web's Hugeicons
# tarball), which would fail an anonymous CI/VPS build.
FROM manifests AS build-deps
RUN bun install --frozen-lockfile --ignore-scripts --filter @artisann-port/discord

# Production dependencies for this app only. Optional dependencies stay enabled
# so sharp's Linux @img/* platform packages are installed for this architecture.
FROM manifests AS prod-deps
RUN bun install --frozen-lockfile --ignore-scripts --production --filter @artisann-port/discord \
    && mkdir -p apps/discord/node_modules

# Bundle inside Linux with the app's own build script.
FROM build-deps AS builder
COPY packages/presence packages/presence
COPY packages/assets packages/assets
COPY apps/discord apps/discord
RUN bun run --cwd apps/discord build

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Root store (node_modules/.bun) plus the app-local node_modules directory, both
# in their original relative layout so Bun's relative symlinks resolve; no
# symlink is created by hand. Dangling links to workspace packages are harmless:
# their source is already bundled into dist and only sharp (external) is loaded
# from disk at run time.
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/apps/discord/node_modules apps/discord/node_modules
COPY --from=prod-deps /app/package.json package.json
COPY --from=prod-deps /app/apps/discord/package.json apps/discord/package.json
# sharp is external to the bundle and loads from its installed Linux module.
COPY --from=builder /app/apps/discord/dist apps/discord/dist

# Files stay root-owned and read-only for the unprivileged `bun` user. No port
# and no volume: the bot only makes outbound Discord and presence-Worker RPC
# connections.
USER bun
ENTRYPOINT ["bun", "--no-env-file", "apps/discord/dist/main.js"]
