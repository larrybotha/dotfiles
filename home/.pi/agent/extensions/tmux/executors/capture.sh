#!/usr/bin/env bash
# Capture bounded pane text.
# usage: capture.sh <name> [lines=200]
# out: {"text":"..."} | {"error":"..."}
# lines clamped 1-2000

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 1 ] || json_fail "usage: capture.sh <name> [lines]"
name=$1
lines=${2:-200}

case $lines in ''|*[!0-9]*) json_fail "invalid lines: '$lines'" ;; esac
[ "$lines" -lt 1 ] && lines=1
[ "$lines" -gt 2000 ] && lines=2000

pane=$(tmux -S "$SOCKET" capture-pane -p -J -t "$name" -S "-$lines" 2>&1) || json_fail "$pane"
json_out "{\"text\":\"$(json_esc "$pane")\"}"
