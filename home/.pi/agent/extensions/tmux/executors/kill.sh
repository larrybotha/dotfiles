#!/usr/bin/env bash
# Kill a session.
# usage: kill.sh <name>
# out: {} | {"error":"..."}
# already-dead = {"error"} (readable); tool unregisters regardless

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/lib.sh"

[ $# -ge 1 ] || json_fail "usage: kill.sh <name>"
name=$1

out=$(tmux -S "$SOCKET" kill-session -t "$name" 2>&1) || json_fail "$out"
json_out '{}'
