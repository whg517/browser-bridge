#!/usr/bin/env bash
# Serve the AI-canvas QA fixtures on two origins: :8000 (main) and :8001
# (cross-origin case). Ctrl-C stops both. Run from this directory.
set -euo pipefail
cd "$(dirname "$0")"

pids=()
cleanup() { echo; echo "stopping…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

for port in 8000 8001; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "!! port $port already in use — free it first (lsof -nP -iTCP:$port -sTCP:LISTEN)"; exit 1
  fi
  python3 -m http.server "$port" >/dev/null 2>&1 &
  pids+=("$!")
  echo "serving http://localhost:$port/  (pid $!)"
done

echo
echo "Open  http://localhost:8000/index.html  in Chrome (extension loaded)."
echo "Press Ctrl-C to stop."
wait
