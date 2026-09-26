#!/usr/bin/env bash
# List live sessions on the extension socket (pi.sock).
# usage: sessions.sh
# out: {"sessions":["pi-<slug>-<n>", ...]}
# no server / no socket = {"sessions":[]} (not an error)

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

ensure_socket_dir

out=$(tmux -S "$SOCKET" list-sessions -F '#{session_name}' 2>&1)
status=$?

if [ $status -ne 0 ]; then
  case $out in
    *"no server running"*|*"No such file or directory"*)
      json_out '{"sessions":[]}'
      ;;
    *)
      json_fail "$out"
      ;;
  esac
fi

items=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  items="$items\"$(json_esc "$name")\","
done < <(printf '%s\n' "$out")

json_out "{\"sessions\":[${items%,}]}"
