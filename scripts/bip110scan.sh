#!/usr/bin/env bash
# Thin shim: the real implementation lives in scripts/scan-bip110.ts
# (bitcoind JSON-RPC batch, ~5-15s for a 2016-block window vs the prior
# Electrum-per-block loop's ~3h). Kept under the old name so existing
# muscle memory / shell history still works.
set -euo pipefail

cd "$(dirname "$0")/.."
exec pnpm tsx scripts/scan-bip110.ts "$@"
