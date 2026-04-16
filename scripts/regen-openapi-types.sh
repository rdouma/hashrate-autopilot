#!/usr/bin/env bash
#
# Refresh the pinned Braiins Hashpower OpenAPI spec and regenerate the
# TypeScript types. Inspect `git diff` afterwards to catch breaking changes.
#
# Usage:  scripts/regen-openapi-types.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPEC_URL="https://hashpower.braiins.com/api/openapi.yml"
SPEC_PATH="$ROOT/packages/braiins-client/openapi.yml"

echo "→ fetching $SPEC_URL"
curl -sfL --max-time 30 -o "$SPEC_PATH" "$SPEC_URL"

echo "→ regenerating types"
pnpm --filter @braiins-hashrate/braiins-client run codegen

echo "→ done. git diff to review API shape changes."
