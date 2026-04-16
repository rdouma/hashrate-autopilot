#!/usr/bin/env bash
#
# Wrapper around `sops` that points at the project's age key.
#
# Usage:  scripts/sops-edit.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XDG_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
export SOPS_AGE_KEY_FILE="$XDG_CONFIG/braiins-hashrate/age.key"

if [[ ! -f "$SOPS_AGE_KEY_FILE" ]]; then
  echo "No age key at $SOPS_AGE_KEY_FILE — run 'pnpm setup' first." >&2
  exit 1
fi

exec sops "$ROOT/.env.sops.yaml"
