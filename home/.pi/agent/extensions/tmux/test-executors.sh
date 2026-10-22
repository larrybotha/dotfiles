#!/usr/bin/env bash
# Executor tests for the tmux read path (resolve_socket/resolve_pane, panes.sh,
# capture.sh). Private socket only, no LLM, no Docker.
# run: bash test-executors.sh

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EX="$ROOT/executors"

pass=0
fail=0
ok() {
  if [ "$2" = "1" ]; then
    pass=$((pass + 1)); echo "ok   - $1"
  else
    fail=$((fail + 1)); echo "FAIL - $1${3:-}"
  fi
}
has() { case $1 in *"$2"*) echo 1 ;; *) echo 0 ;; esac; }
lacks() { case $1 in *"$2"*) echo 0 ;; *) echo 1 ;; esac; }

DIR=$(mktemp -d)
export AGENT_TMUX_SOCKET_DIR="$DIR"
SOCK="$DIR/pi.sock"

cleanup() {
  tmux -S "$SOCK" kill-server 2>/dev/null
  rm -rf "$DIR"
}
trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "skip: tmux not installed"
  exit 0
fi

# ---- fixture: private socket -----------------------------------------------
tmux -S "$SOCK" -f /dev/null new-session -d -s pma-main -x 80 -y 24
tmux -S "$SOCK" set-option -g base-index 1
tmux -S "$SOCK" set-option -g pane-base-index 1
tmux -S "$SOCK" new-window -t pma-main:2
tmux -S "$SOCK" split-window -t pma-main:2
tmux -S "$SOCK" split-window -t pma-main:2
tmux -S "$SOCK" split-window -t pma-main:2
tmux -S "$SOCK" select-layout -t pma-main:2 tiled
tmux -S "$SOCK" new-session -d -s pma -x 80 -y 24
tmux -S "$SOCK" new-session -d -s pi-x -x 80 -y 24

# pane 3 of window 2: one 500-char logical line, then sleep
tmux -S "$SOCK" send-keys -t pma-main:2.3 -l 'head -c 500 /dev/zero | tr "\0" x; echo'
tmux -S "$SOCK" send-keys -t pma-main:2.3 Enter
sleep 0.6

XS=$(printf 'x%.0s' {1..500})

# ---- panes.sh --------------------------------------------------------------
out=$("$EX/panes.sh" pi)
ok "panes.sh: returns a panes array" "$(has "$out" '"panes":[')"
ok "panes.sh: includes pma-main panes" "$(has "$out" '"session_name":"pma-main"')"
ok "panes.sh: includes a pane_id" "$(has "$out" '"pane_id":"%')"

out2=$("$EX/panes.sh" pi 2)
n=$(printf '%s' "$out2" | grep -o '"pane_id"' | wc -l | tr -d ' ')
ok "panes.sh limit=2: two records" "$([ "$n" = "2" ] && echo 1 || echo 0)" "got $n"
ok "panes.sh limit=2: truncated true" "$(has "$out2" '"truncated":true')"

first_id=$(printf '%s' "$out" | sed -n 's/.*"pane_id":"\(%[0-9]*\)".*/\1/p' | head -n 1)
ok "panes.sh: extracted a pane id" "$([ -n "$first_id" ] && echo 1 || echo 0)" "$first_id"

# ---- capture.sh external (3+ args) ----------------------------------------
out=$("$EX/capture.sh" pma-main:2.3 50 pi)
ok "capture external: 500-char logical line joined (-J)" "$(has "$out" "$XS")"
ok "capture external: resolvedTarget present" "$(has "$out" '"resolvedTarget":"pma-main:2.3"')"
ok "capture external: paneId present" "$(has "$out" '"paneId":"%')"

out=$("$EX/capture.sh" pma-main:2.3 50 pi 0)
ok "capture external join=0: wrapped (no 500-char run)" "$(lacks "$out" "$XS")"
ok "capture external join=0: still text" "$(has "$out" '"text"')"

out=$("$EX/capture.sh" "$first_id" 50 pi)
ok "capture external by %id: works" "$(has "$out" '"paneId":"'"$first_id"'"')"

out=$("$EX/capture.sh" pma 50 pi)
ok "capture external bare sess: matches pma" "$(has "$out" '"resolvedTarget":"pma:')"
ok "capture external bare sess: not pma-main" "$(lacks "$out" 'pma-main')"

# ---- capture.sh legacy (two args) -----------------------------------------
out=$("$EX/capture.sh" pi-x 10)
ok "capture legacy: text key" "$(has "$out" '"text"')"
ok "capture legacy: no external metadata" "$(lacks "$out" 'resolvedTarget')"

# ---- socket spec -----------------------------------------------------------
out=$(TMUX="$SOCK,$$,0" "$EX/capture.sh" pma-main:2.3 50 current)
ok "capture current socket: works with \$TMUX set" "$(has "$out" '"paneId":"%')"

out=$("$EX/capture.sh" pma-main:2.3 50 garbage)
ok "capture invalid socket: rejected" "$(has "$out" '"error"')"

# ---- invalid targets -------------------------------------------------------
out=$("$EX/capture.sh" pma-main:2.9 50 pi)
ok "invalid target sess:win.pane: no pane" "$(has "$out" 'no pane')"

out=$("$EX/capture.sh" %999 50 pi)
ok "invalid target %999: no pane" "$(has "$out" 'no pane')"

out=$("$EX/capture.sh" %abc 50 pi)
ok "invalid target %abc: rejected" "$(has "$out" 'invalid pane id')"

out=$("$EX/capture.sh" -t 50 pi)
ok "invalid target -t: no pane (never reaches tmux -t)" "$(has "$out" 'no pane')"

out=$("$EX/capture.sh" '{marked}' 50 pi)
ok "invalid target {marked}: no pane" "$(has "$out" 'no pane')"

out=$("$EX/capture.sh" "$(printf 'a\x01b')" 50 pi)
ok "invalid target control char: rejected" "$(has "$out" 'control')"

# ---- resolve_pane leaves tmux state untouched on failure -------------------
before=$(tmux -S "$SOCK" list-panes -a -F '#{pane_id}' | sort)
"$EX/capture.sh" -t 50 pi >/dev/null
after=$(tmux -S "$SOCK" list-panes -a -F '#{pane_id}' | sort)
ok "failed resolution: no tmux side effect" "$([ "$before" = "$after" ] && echo 1 || echo 0)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
