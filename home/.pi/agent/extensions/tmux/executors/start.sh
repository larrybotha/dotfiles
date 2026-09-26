#!/usr/bin/env bash
# Start a detached session on the extension socket.
# usage: start.sh <name> <cmd> [args...]
# out: {"socket":"...","name":"pi-..."} | {"error":"..."}
# name must be pre-suffixed unique (pi-<slug>-<n>) — tool computes it

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 2 ] || json_fail "usage: start.sh <name> <cmd> [args...]"
name=$1
shift

case $name in
  *[.:]*) json_fail "invalid session name '$name': tmux rejects '.' and ':'" ;;
esac

ensure_socket_dir

out=$(tmux -S "$SOCKET" -f /dev/null new-session -d -s "$name" "$@" 2>&1) || json_fail "$out"
json_out "{\"socket\":\"$(json_esc "$SOCKET")\",\"name\":\"$(json_esc "$name")\"}"
