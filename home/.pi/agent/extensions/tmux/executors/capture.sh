#!/usr/bin/env bash
# Capture bounded pane text.
# usage: capture.sh <target> [lines=200] [socket=pi] [join=1]
#   - one/two args: managed pi.sock session id (legacy path: exact =name, first
#     pane of the current window) — output stays {"text":"..."}
#   - three+ args: explicit socket + pane target (sess | sess:win | sess:win.pane | %N)
# out: {"text":"..."} | {"text":"...","resolvedTarget":"...","paneId":"...","truncated":bool}
# lines clamped 1-2000; joined text capped at 512 KiB

set -u
export LC_ALL=C

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 1 ] || json_fail "usage: capture.sh <target> [lines] [socket] [join]"
target=$1
lines=${2:-200}

case $lines in ''|*[!0-9]*) json_fail "invalid lines: '$lines'" ;; esac
[ "$lines" -lt 1 ] && lines=1
[ "$lines" -gt 2000 ] && lines=2000

CAP=524288
truncated=false

# managed legacy path: tmux rejects a bare =name as a pane target, and a bare
# name would prefix-match another session. %N pane ids are server-unique.
if [ $# -le 2 ]; then
  pane_id=$(tmux -S "$SOCKET" list-panes -t "=$target" -F '#{pane_id}' 2>/dev/null | head -n 1)
  [ -n "$pane_id" ] || json_fail "can't find pane: $target"
  pane=$(tmux -S "$SOCKET" capture-pane -p -J -t "$pane_id" -S "-$lines" 2>&1) || json_fail "$pane"
  if [ "${#pane}" -gt "$CAP" ]; then pane=${pane:0:CAP}; truncated=true; fi
  json_out "{\"text\":\"$(json_esc "$pane")\"}"
fi

spec=${3:-pi}
join=${4:-1}

resolve_socket "$spec" || json_fail "$SOCKET_ERROR"
resolve_pane "$target" || json_fail "$SOCKET_ERROR"

if [ "$join" = "0" ]; then
  pane=$(tmux "${TMUX_ARGS[@]}" capture-pane -p -t "$PANE_ID" -S "-$lines" 2>&1) || json_fail "$pane"
else
  pane=$(tmux "${TMUX_ARGS[@]}" capture-pane -p -J -t "$PANE_ID" -S "-$lines" 2>&1) || json_fail "$pane"
fi
if [ "${#pane}" -gt "$CAP" ]; then pane=${pane:0:CAP}; truncated=true; fi

json_out "{\"text\":\"$(json_esc "$pane")\",\"resolvedTarget\":\"$(json_esc "$RESOLVED_TARGET")\",\"paneId\":\"$(json_esc "$PANE_ID")\",\"truncated\":$truncated}"
