#!/usr/bin/env bash
#
# Stop the daemon gracefully (SIGTERM, then SIGKILL after 10s).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "daemon not running (no PID file)"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID not running; clearing stale PID file"
  rm "$PID_FILE"
  exit 0
fi

echo "sending SIGTERM to PID $PID"
kill -TERM "$PID"

# Wait up to 10s for a clean shutdown.
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "daemon stopped"
    exit 0
  fi
  sleep 0.5
done

echo "SIGTERM didn't stop daemon within 10s; sending SIGKILL"
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "daemon killed"
