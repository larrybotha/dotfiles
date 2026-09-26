#!/usr/bin/env bash
# Poll a session pane for a regex until timeout.
# usage: wait.sh <name> <regex> [timeout_s=15] [interval_s=0.5] [lines=200]
# out: {"matched":true|false,"lastPane":"..."} | {"error":"..."}
# capture window slides with history (-S -$lines): scrolled output still matches.
# dead session = {"error"} — distinguishable from timeout

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 2 ] || json_fail "usage: wait.sh <name> <regex> [timeout_s] [interval_s] [lines]"
name=$1
regex=$2
timeout=${3:-15}
interval=${4:-0.5}
lines=${5:-200}

case $timeout in ''|*[!0-9]*) json_fail "timeout must be a non-negative integer: '$timeout'" ;; esac
case $interval in ''|*[!0-9.]*) json_fail "invalid interval: '$interval'" ;; esac
case $lines in ''|*[!0-9]*) json_fail "invalid lines: '$lines'" ;; esac
[ -n "$regex" ] || json_fail "empty regex"
[ "$lines" -gt 0 ] 2>/dev/null || lines=200

deadline=$(( $(date +%s) + timeout ))
pane=""

while :; do
  pane=$(tmux -S "$SOCKET" capture-pane -p -J -t "$name" -S "-$lines" 2>&1)
  if [ $? -ne 0 ]; then
    json_fail "$pane"
  fi

  rc=0
  printf '%s\n' "$pane" | grep -Eq -- "$regex" || rc=$?
  if [ $rc -eq 0 ]; then
    json_out "{\"matched\":true,\"lastPane\":\"$(json_esc "$pane")\"}"
  elif [ $rc -ge 2 ]; then
    json_fail "invalid regex: $regex"
  fi

  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$interval"
done

json_out "{\"matched\":false,\"lastPane\":\"$(json_esc "$pane")\"}"
