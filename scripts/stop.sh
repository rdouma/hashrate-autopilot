#!/usr/bin/env bash
#
# Stop the daemon gracefully (SIGTERM, then SIGKILL after 10s).
# Falls back to killing whatever holds port 3010 if the PID file
# is stale or the child process outlived the parent.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/daemon.pid"
PORT="${HTTP_PORT:-3010}"

kill_tree() {
  local pid="$1"
  # Kill the entire process group so child node processes die too.
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
}

# Try PID file first.
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "sending SIGTERM to PID $PID (and children)"
    kill_tree "$PID"
    for _ in $(seq 1 20); do
      if ! kill -0 "$PID" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "SIGTERM didn't stop daemon within 10s; sending SIGKILL"
      kill -KILL "$PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

# Fallback: kill anything still holding the port.
PORT_PID="$(lsof -ti :"$PORT" 2>/dev/null || true)"
if [[ -n "$PORT_PID" ]]; then
  echo "killing orphan process on port $PORT (PID $PORT_PID)"
  kill -TERM $PORT_PID 2>/dev/null || true
  sleep 1
  # Force-kill if still alive.
  for p in $PORT_PID; do
    kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null || true
  done
fi

echo "daemon stopped"
