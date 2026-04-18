#!/usr/bin/env bash
#
# Pull latest, install deps, build, and restart the daemon.
# Run this on the deployment machine (Pi / desktop) after pushing
# from the dev machine. Safe to run while the daemon is live —
# the restart happens after the build succeeds.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> pulling latest..."
git pull --ff-only

echo "==> installing dependencies..."
pnpm install --frozen-lockfile

echo "==> building..."
pnpm build

echo "==> running tests..."
pnpm test

echo "==> restarting daemon..."
./scripts/restart.sh

echo "==> done. dashboard at http://$(hostname):${HTTP_PORT:-3010}"
