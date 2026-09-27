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

# resolve the session's active pane by id first: tmux rejects a bare =name
# as a pane target, and a bare name would prefix-match another session.
# %N pane ids are server-unique — no ambiguity, no prefix risk
pane_id=$(tmux -S "$SOCKET" list-panes -t "=$name" -F '#{pane_id}' 2>/dev/null | head -n 1)
[ -n "$pane_id" ] || json_fail "can't find pane: $name"

pane=$(tmux -S "$SOCKET" capture-pane -p -J -t "$pane_id" -S "-$lines" 2>&1) || json_fail "$pane"
json_out "{\"text\":\"$(json_esc "$pane")\"}"
