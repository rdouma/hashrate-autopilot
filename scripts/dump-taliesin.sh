#!/usr/bin/env bash
# Mirror of scripts/dump-clarent.sh for the Taliesin test machine.
# Saves a /api/debug/dump JSON to data/dump-taliesin-<timestamp>.json
# so Claude can analyze it locally.
set -euo pipefail

HOST="taliesin.local:3010"
USER="admin"
PASS="hacked-noelle-papers"

OUT="data/dump-taliesin-$(date +%Y%m%d-%H%M%S).json"

curl -fsSL -u "${USER}:${PASS}" "http://${HOST}/api/debug/dump" -o "${OUT}"
echo "Saved to ${OUT}"
