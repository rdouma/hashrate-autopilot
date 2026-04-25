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

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /app

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

# Drop dev dependencies. The remaining node_modules carries only
# what's needed at runtime; combined with the dist directories that
# `pnpm build` produced, this is the runnable artefact.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

# Non-root operator user. Apps under Umbrel/Start9 run with constrained
# UIDs already, but baking it in here keeps `docker run` parity sane.
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid app --home-dir /home/app --create-home app

# Pull the runnable bits from the builder. We need:
#   - node_modules (production deps + workspace symlinks)
#   - packages/<each>/dist (compiled output)
#   - packages/<each>/package.json (so the workspace symlinks resolve)
#   - root pnpm-workspace.yaml + package.json (workspace roots)
#   - migrations (copied into dist by the daemon's build script)
COPY --from=builder --chown=app:app /app/node_modules /app/node_modules
COPY --from=builder --chown=app:app /app/packages /app/packages
COPY --from=builder --chown=app:app /app/package.json /app/pnpm-workspace.yaml ./

# Persistent state directory. Operators should mount a volume here
# (Umbrel/Start9 do this declaratively in their app manifests; for
# `docker run` use `-v hashrate-data:/app/data`).
RUN mkdir -p /app/data && chown app:app /app/data
VOLUME /app/data

USER app
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
