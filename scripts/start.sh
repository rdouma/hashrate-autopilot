#!/usr/bin/env bash
#
# Start the Braiins autopilot daemon in the background.
# Writes the PID to data/daemon.pid and appends stdout/stderr to data/logs/daemon.log.
# No-op if already running.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"
LOG_FILE="$ROOT/data/logs/daemon.log"

mkdir -p "$(dirname "$LOG_FILE")"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "daemon already running (PID $PID). See scripts/status.sh."
    exit 0
  fi
  echo "stale PID file ($PID not running); clearing"
  rm "$PID_FILE"
fi

cd "$ROOT"
HTTP_PORT="${HTTP_PORT:-3010}" nohup pnpm -w run daemon >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 0.3
echo "daemon started  (PID $(cat "$PID_FILE"))"
echo "logs:  tail -f $LOG_FILE"
