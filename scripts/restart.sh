#!/usr/bin/env bash
#
# Stop and then start the daemon.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/stop.sh"
sleep 0.5
"$ROOT/scripts/start.sh"
