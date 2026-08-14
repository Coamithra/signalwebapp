#!/usr/bin/env bash
# Restart the server: free the port, then start it again in the foreground.
#
# The whole reason this exists is that `npm start` fails with EADDRINUSE if the
# previous server is still holding 127.0.0.1:7700, and finding that process by
# hand is three commands of netstat/taskkill every time.
#
# Runs the server from THIS checkout, so calling it inside a worktree starts that
# worktree's code — which is the point when testing a branch.
#
# Usage:  bash scripts/reboot.sh          (or: npm run reboot)
#         PORT=7800 bash scripts/reboot.sh
set -uo pipefail

PORT="${PORT:-7700}"
# Resolve the repo root from this script's own location, not from the caller's
# cwd, so it works from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Find the PID listening on PORT. Windows-first (this is a Windows app -- it
# drives Signal Desktop over CDP), falling back to lsof so the script still does
# the right thing under WSL or on a Mac.
listener_pid() {
  if command -v netstat >/dev/null 2>&1 && netstat -ano >/dev/null 2>&1; then
    # The address column ends in :PORT, and LISTENING excludes the established
    # connections from browser tabs -- killing one of those would be a no-op at
    # best and the wrong process at worst.
    netstat -ano 2>/dev/null \
      | awk -v p=":$PORT" '$1 ~ /^TCP/ && $2 ~ p"$" && $4 == "LISTENING" { print $5; exit }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$PORT" -s TCP:LISTEN 2>/dev/null | head -1
  fi
}

PID="$(listener_pid || true)"
if [ -n "${PID:-}" ]; then
  echo "port $PORT held by pid $PID — stopping it"
  if command -v taskkill >/dev/null 2>&1; then
    # Git Bash mangles single-dash args into paths, hence the doubled slashes.
    taskkill //PID "$PID" //F >/dev/null 2>&1 || taskkill /PID "$PID" /F >/dev/null 2>&1 || true
  else
    kill "$PID" 2>/dev/null || true
  fi
  # The port is not free the instant the process dies; wait for it rather than
  # racing straight into another EADDRINUSE.
  for _ in $(seq 1 20); do
    [ -z "$(listener_pid || true)" ] && break
    sleep 0.25
  done
  if [ -n "$(listener_pid || true)" ]; then
    echo "could not free port $PORT (pid $(listener_pid)) — stop it by hand" >&2
    exit 1
  fi
else
  echo "port $PORT is free"
fi

echo "starting server from $ROOT"
cd "$ROOT"
exec npm start
