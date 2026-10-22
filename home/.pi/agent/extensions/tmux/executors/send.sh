#!/usr/bin/env bash
# Send text to a session: one literal send, then Enter iff needed.
# usage: send.sh <name> <text>
# out: {} | {"error":"..."}
# text goes as-is: embedded \n submit lines. If text ends with \n, lines are
# already submitted and NO extra Enter is appended — the model supplies blank
# lines (trailing \n\n) to terminate REPL blocks. Enter is appended only when
# text lacks a trailing newline (plain command case).

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 2 ] || json_fail "usage: send.sh <name> <text>"
name=$1
text=$2

# resolve the session's active pane via the shared resolver (same grammar as
# tmux_capture: sess | sess:win | sess:win.pane | %N). %N pane ids are
# server-unique — no ambiguity, no prefix risk.
resolve_socket pi || json_fail "$SOCKET_ERROR"
resolve_pane "$name" || json_fail "$SOCKET_ERROR"
pane_id=$PANE_ID

out=$(tmux -S "$SOCKET" send-keys -t "$pane_id" -l "$text" 2>&1) || json_fail "$out"

if [ -z "$text" ] || [ "${text%$'\n'}" != "$text" ]; then
  json_out '{}'
fi

out=$(tmux -S "$SOCKET" send-keys -t "$pane_id" Enter 2>&1) || json_fail "$out"
json_out '{}'
