#!/usr/bin/env bash
# List live sessions on the extension socket (pi.sock) with owner evidence.
# usage: probe.sh
# out: {"sessions":[{"name":"pi-...","owner":"<pid>","ownerAlive":true|false},...]}
# no server / no socket = {"sessions":[]} (not an error)
#
# owner = PI_OWNER session env, set at creation by start.sh (creating pi's
# pid; "" = untagged: legacy sessions from before owner tagging, or manual
# starts). ownerAlive = kill -0 <pid> — the owning pi still runs. A pid owned
# by another user reads as gone (permission denied on kill -0); single-user
# machine assumption, same as the whole socket.
#
# sessions.sh (plain string array) stays for in-memory older pi instances —
# their index.ts parses strings; this contract change would crash them.

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
  owner=""
  ownerAlive=false
  # exact target (=name): no tmux prefix matching against other sessions
  envline=$(tmux -S "$SOCKET" show-environment -t "=$name" PI_OWNER 2>/dev/null) || envline=""
  case $envline in
    PI_OWNER=*) owner=${envline#PI_OWNER=} ;;
  esac
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    ownerAlive=true
  fi
  items="$items{\"name\":\"$(json_esc "$name")\",\"owner\":\"$(json_esc "$owner")\",\"ownerAlive\":$ownerAlive},"
done < <(printf '%s\n' "$out")

json_out "{\"sessions\":[${items%,}]}"
