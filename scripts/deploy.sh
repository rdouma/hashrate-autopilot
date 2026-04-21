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
git fetch --prune
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse @{u})
BASE_SHA=$(git merge-base HEAD @{u})
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "==> already up to date."
elif [ "$LOCAL_SHA" = "$BASE_SHA" ]; then
  git merge --ff-only @{u}
else
  # Remote has been rewritten (force-push). Fast-forward is impossible
  # and auto-resetting could silently discard a legitimate local WIP
  # commit, so stop here and point at the one-line recovery.
  cat <<RECOVERY >&2
==> ERROR: local main is not a fast-forward of origin/main.

This usually means origin/main was force-pushed (history rewritten).
Your local HEAD ($LOCAL_SHA) has diverged from origin ($REMOTE_SHA).

To recover (discards any unpushed local commits on this branch):

    git reset --hard origin/main

Then re-run ./scripts/deploy.sh.

If you have local commits you want to keep, inspect them first with
\`git log --oneline origin/main..HEAD\` before resetting.
RECOVERY
  exit 1
fi

echo "==> installing dependencies..."
pnpm install --frozen-lockfile

echo "==> building..."
pnpm build

echo "==> running tests..."
pnpm test

echo "==> restarting daemon..."
./scripts/restart.sh

echo "==> done. dashboard at http://$(hostname):${HTTP_PORT:-3010}"
