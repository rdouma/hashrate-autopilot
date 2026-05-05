#!/usr/bin/env bash
# Thin shim: the real implementation lives in scripts/scan-bip110.ts
# (bitcoind JSON-RPC batch, ~5-15s for a 2016-block window vs the prior
# Electrum-per-block loop's ~3h). Kept under the old name so existing
# muscle memory / shell history still works.
set -euo pipefail

# ---------------------------------------------------------------------------
# bitcoind RPC credentials. POPULATE LOCALLY - DO NOT COMMIT REAL VALUES.
#
# After filling these in, mark the file as locally-modified-only so a future
# `git add` does not capture your secrets:
#
#     git update-index --skip-worktree scripts/bip110scan.sh
#
# To undo:
#     git update-index --no-skip-worktree scripts/bip110scan.sh
#
# Same variable names as the BHA_* env vars the daemon uses, so values
# from your shell environment win when set (the `:-` fallback only kicks
# in when the env var is unset or empty).
# ---------------------------------------------------------------------------
export BHA_BITCOIND_RPC_URL="${BHA_BITCOIND_RPC_URL:-}"
export BHA_BITCOIND_RPC_USER="${BHA_BITCOIND_RPC_USER:-}"
export BHA_BITCOIND_RPC_PASSWORD="${BHA_BITCOIND_RPC_PASSWORD:-}"

cd "$(dirname "$0")/.."
exec pnpm tsx scripts/scan-bip110.ts "$@"
