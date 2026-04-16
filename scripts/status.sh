#!/usr/bin/env bash
#
# Print current daemon status. Exits 0 if running, 1 otherwise.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"
LOG_FILE="$ROOT/data/logs/daemon.log"

if [[ ! -f "$PID_FILE" ]]; then
  echo "daemon: not running (no PID file)"
  exit 1
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  echo "daemon: running (PID $PID)"
  ps -p "$PID" -o pid,etime,command
  echo
  echo "recent logs (last 10 lines of $LOG_FILE):"
  tail -n 10 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
  exit 0
fi

echo "daemon: not running (PID file references dead process $PID)"
exit 1
