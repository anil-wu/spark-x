#!/bin/sh
set -e

cd /workspace

opencode serve --port 4096 --hostname 0.0.0.0 &
opencode_pid="$!"

PORT="${WORKSPACE_MANAGE_PORT:-7070}" node /opt/workspace_manage/src/server.js &
workspace_pid="$!"

terminate() {
  kill -TERM "$opencode_pid" "$workspace_pid" 2>/dev/null || true
  wait "$opencode_pid" 2>/dev/null || true
  wait "$workspace_pid" 2>/dev/null || true
}

trap terminate INT TERM

while :; do
  if ! kill -0 "$opencode_pid" 2>/dev/null; then
    wait "$opencode_pid"
    terminate
    exit 1
  fi
  if ! kill -0 "$workspace_pid" 2>/dev/null; then
    wait "$workspace_pid"
    terminate
    exit 1
  fi
  sleep 1
done

