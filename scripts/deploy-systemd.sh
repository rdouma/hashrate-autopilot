#!/usr/bin/env bash
#
# Pull latest, install deps, build, test, and restart the systemd-
# managed daemon.
#
# Variant of scripts/deploy.sh for boxes where the daemon runs under
# systemd (see README C.5). Identical pull/build/test pipeline as
# deploy.sh; the only difference is the last step calls
# `systemctl restart hashrate-autopilot` instead of scripts/restart.sh
# (which uses PID files and would either no-op or race with systemd).
#
# Requires sudo for the systemctl call. Configure passwordless sudo
# for that one command if you want a fully unattended cron:
#
#   echo "$(whoami) ALL=(ALL) NOPASSWD: /bin/systemctl restart hashrate-autopilot" \
#     | sudo tee /etc/sudoers.d/hashrate-autopilot-restart
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVICE_NAME="${HASHRATE_AUTOPILOT_SERVICE:-hashrate-autopilot}"

echo "==> pulling latest..."
git fetch --prune
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse @{u})
BASE_SHA=$(git merge-base HEAD @{u})
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "==> already up to date."
elif [ "$LOCAL_SHA" = "$BASE_SHA" ]; then
  git merge --ff-only @{u}
else
  # Remote has been rewritten (force-push). Same recovery story as
  # scripts/deploy.sh - keep them in sync.
  cat <<RECOVERY >&2
==> ERROR: local main is not a fast-forward of origin/main.

This usually means origin/main was force-pushed (history rewritten).
Your local HEAD ($LOCAL_SHA) has diverged from origin ($REMOTE_SHA).

To recover (discards any unpushed local commits on this branch):

    git reset --hard origin/main

Then re-run ./scripts/deploy-systemd.sh.

If you have local commits you want to keep, inspect them first with
\`git log --oneline origin/main..HEAD\` before resetting.
RECOVERY
  exit 1
fi

echo "==> installing dependencies..."
pnpm install --frozen-lockfile

# Force a full recompile by dropping the incremental build cache, but
# do NOT delete packages/*/dist up front. The daemon runs from source
# via tsx yet resolves its sibling workspace packages through their
# built dist/. If we nuke dist and the build (or the tests below) then
# fails, `set -e` aborts mid-deploy with dist already gone, and a
# Restart=always systemd unit flaps the daemon forever on
# ERR_MODULE_NOT_FOUND. Letting tsc overwrite in place keeps the last
# good dist intact on a failed build, so the running daemon survives.
# (Deleting tsbuildinfo still forces every current source to re-emit;
# an orphaned .js from a since-deleted source is dead weight, never
# imported at runtime.)
echo "==> forcing full recompile (clearing tsbuildinfo)..."
find packages -name 'tsconfig.tsbuildinfo' -not -path '*/node_modules/*' -delete

echo "==> building..."
pnpm build

echo "==> running tests..."
pnpm test

echo "==> restarting systemd unit ${SERVICE_NAME}..."
sudo systemctl restart "${SERVICE_NAME}"

echo "==> waiting for service to settle..."
sleep 2
sudo systemctl --no-pager status "${SERVICE_NAME}" | head -8

echo "==> done. dashboard at http://$(hostname):${HTTP_PORT:-3010}"
