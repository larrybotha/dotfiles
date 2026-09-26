# Shared helpers for tmux executors. Sourced, not run.
# Contract: JSON on stdout, exit 0 always. Failures are {"error": "..."} data.
# Extends skill convention: AGENT_TMUX_SOCKET_DIR (default ${TMPDIR:-/tmp}/agent-tmux-sockets),
# extension owns pi.sock inside it.

AGENT_TMUX_SOCKET_DIR="${AGENT_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/agent-tmux-sockets}"
SOCKET="$AGENT_TMUX_SOCKET_DIR/pi.sock"

ensure_socket_dir() {
  if ! mkdir -p "$AGENT_TMUX_SOCKET_DIR" 2>/dev/null; then
    printf '{"error":"cannot create socket dir %s"}\n' "$AGENT_TMUX_SOCKET_DIR"
    exit 0
  fi
}

json_esc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # strip remaining control chars (ESC, BS, BEL, ...); pane text is otherwise printable
  s=$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177')
  printf '%s' "$s"
}

json_out() { printf '%s\n' "$1"; exit 0; }
json_fail() { printf '{"error":"%s"}\n' "$(json_esc "$1")"; exit 0; }
