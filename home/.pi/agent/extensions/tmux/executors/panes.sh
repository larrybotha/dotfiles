#!/usr/bin/env bash
# List panes on a socket (metadata only; never pane text). Read-only.
# usage: panes.sh <socket=pi> [limit=200]
# out: {"panes":[{...}],"total":N,"truncated":true|false} | {"error":"..."}
# record cap 200, byte cap 64 KiB; caps signalled by truncated + total.
# no server = empty panes (not an error)

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

spec=${1:-pi}
limit=${2:-200}

case $limit in ''|*[!0-9]*) json_fail "invalid limit: '$limit'" ;; esac
[ "$limit" -lt 1 ] && limit=1
[ "$limit" -gt 200 ] && limit=200

resolve_socket "$spec" || json_fail "$SOCKET_ERROR"

TAB=$'\t'
FMT="#{session_name}${TAB}#{window_index}${TAB}#{pane_index}${TAB}#{pane_id}${TAB}#{pane_active}${TAB}#{window_active}${TAB}#{pane_current_command}${TAB}#{pane_pid}${TAB}#{pane_tty}${TAB}#{pane_dead}${TAB}#{window_name}"

rows=$(tmux "${TMUX_ARGS[@]}" list-panes -a -F "$FMT" 2>/dev/null) || rows=""

num() { case $1 in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

full_total=$(printf '%s\n' "$rows" | grep -c .)

items=""
emitted=0
truncated=false
while IFS="$TAB" read -r sname widx pidx pid pact wact cmd ppid tty dead wname; do
  [ -n "$sname" ] || continue
  if [ "$emitted" -ge "$limit" ]; then truncated=true; break; fi
  rec="{\"session_name\":\"$(json_esc "$sname")\",\"window_index\":$(num "$widx"),\"pane_index\":$(num "$pidx"),\"pane_id\":\"$(json_esc "$pid")\",\"pane_active\":$(num "$pact"),\"window_active\":$(num "$wact"),\"pane_current_command\":\"$(json_esc "$cmd")\",\"pane_pid\":$(num "$ppid"),\"pane_tty\":\"$(json_esc "$tty")\",\"pane_dead\":$(num "$dead"),\"window_name\":\"$(json_esc "$wname")\"},"
  if [ $(( ${#items} + ${#rec} )) -gt 65536 ]; then truncated=true; break; fi
  items="$items$rec"
  emitted=$((emitted + 1))
done <<< "$rows"

[ "$emitted" -lt "$full_total" ] && truncated=true

json_out "{\"panes\":[${items%,}],\"total\":${full_total},\"truncated\":$truncated}"
