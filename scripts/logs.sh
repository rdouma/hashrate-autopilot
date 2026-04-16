#!/usr/bin/env bash
#
# Tail the daemon log. Ctrl+C to exit.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$ROOT/data/logs/daemon.log"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "No log file at $LOG_FILE yet. Start the daemon first."
  exit 1
fi

exec tail -f "$LOG_FILE"
