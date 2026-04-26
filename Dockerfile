# syntax=docker/dockerfile:1.7
#
# Production image for the Braiins Hashrate Autopilot daemon (#58).
#
# Builds the entire workspace (daemon + dashboard + clients) in a
# builder stage, prunes dev deps, then assembles a minimal runtime
# image. Multi-arch (linux/amd64 + linux/arm64) — Pi-class ARM64
# is a hard requirement for Umbrel/Start9. The CI workflow at
# `.github/workflows/docker-publish.yml` produces both architectures
# via `docker buildx` on every `v*` tag.
#
# The image listens on port 3010 by default and persists everything
# operator-relevant (config, secrets, tick history, owned-bid ledger)
# under `/app/data` — mount that as a named volume on the host so
# state survives container recreation.

ARG NODE_VERSION=22

# Short git SHA threaded in by CI (`docker buildx build --build-arg
# GIT_SHA=...`). The dashboard footer reads it via Vite's
# `process.env.GIT_SHA` to print `build N - <sha>`. .dockerignore
# excludes the .git/ dir from the build context, so without this
# arg every Docker-baked dashboard footer would say "dev".
ARG GIT_SHA=dev

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /app

# Re-declare in the builder stage scope and export to environment
# so vite.config.ts's `process.env.GIT_SHA` lookup picks it up.
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}

# better-sqlite3 needs python3 + a C++ toolchain to compile its
# native binding when prebuilt binaries aren't available for the
# target arch. Only present in the builder image; runtime image
# carries the compiled artefact only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack so the lockfile-pinned pnpm version is used.
RUN corepack enable

# Prime the dependency layer with manifests only — this layer
# rebuilds only when a package.json or the lockfile changes, not
# on every source edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/braiins-client/package.json packages/braiins-client/
COPY packages/bitcoind-client/package.json packages/bitcoind-client/
COPY packages/daemon/package.json packages/daemon/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# Now copy source and build everything (daemon TS → JS, dashboard
# Vite bundle, migrations stage-copied into dist).
COPY . .
RUN pnpm build

# NOTE: we intentionally do NOT run `pnpm prune --prod` here. In a
# pnpm workspace, the daemon resolves sibling packages via symlinks
# under `node_modules/@braiins-hashrate/*`; prune --prod deletes the
# modules directory and reinstalls without preserving those workspace
# links, which leaves the daemon throwing
# `ERR_MODULE_NOT_FOUND: Cannot find package '@braiins-hashrate/...'`
# at runtime. The size cost of keeping dev deps is ~100 MB, accepted
# until we move to a pnpm-deploy-based pipeline.

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

# Pull the runnable bits from the builder. We need:
#   - node_modules (production deps + workspace symlinks)
#   - packages/<each>/dist (compiled output)
#   - packages/<each>/package.json (so the workspace symlinks resolve)
#   - root pnpm-workspace.yaml + package.json (workspace roots)
#   - migrations (copied into dist by the daemon's build script)
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./

# Persistent state directory. Operators should mount a volume here
# (Umbrel/Start9 do this declaratively in their app manifests; for
# `docker run` use `-v hashrate-data:/app/data`).
RUN mkdir -p /app/data
VOLUME /app/data

# Run as root inside the container. Rationale: Umbrel/Start9 bind-mount
# the host's per-app data directory at /app/data, and that host
# directory is created on first boot with whatever ownership the
# orchestrator's docker daemon uses (typically root). A non-root
# in-container user (uid 1000) then cannot write to the mount, and
# the daemon crashes with `unable to open database file`. Running as
# root keeps the bind-mount writable on every host. Network exposure
# is mediated by the app_proxy sidecar in docker-compose.yml, which
# is the actual security boundary; the daemon itself only listens on
# 3010 and serves its own Basic Auth.
EXPOSE 3010

# Health probe — the daemon's /api/health is the canonical liveness
# endpoint (#67). Public, fast, returns mode=NEEDS_SETUP or mode=OPERATIONAL.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3010/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3010 \
    DB_PATH=/app/data/state.db \
    DASHBOARD_STATIC=packages/dashboard/dist

CMD ["node", "packages/daemon/dist/main.js"]
