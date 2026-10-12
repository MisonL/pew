# Image for every deploy/selfhost service that runs TS via bun (migrate,
# d1-http, read, ingest, scheduler). The repo-root Dockerfile's runner stage
# cannot run them: it is a node:22-slim Next.js standalone image with no bun,
# no deploy/, no package sources and no migrations.
#
# This is NOT the image for `web` — web is a Next.js standalone build and uses
# the repo-root Dockerfile (see compose: web's build points at ./Dockerfile).
FROM oven/bun:1.4.0 AS build

WORKDIR /app

# Workspace metadata first so dependency layers cache independently of source.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY packages/worker-read/package.json packages/worker-read/
COPY packages/cli/package.json packages/cli/
RUN bun install --frozen-lockfile

# Source for @pew/core — its package.json "main" is ./dist/index.js, so the
# dist must exist even when bun runs TS entrypoints directly.
COPY tsconfig.json ./
COPY packages/core packages/core
RUN bun run --filter @pew/core build

COPY packages/web packages/web
COPY packages/worker packages/worker
COPY packages/worker-read packages/worker-read
COPY scripts scripts
COPY deploy deploy

ENV NODE_ENV=production
