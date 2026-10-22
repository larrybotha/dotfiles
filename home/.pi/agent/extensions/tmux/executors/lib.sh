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

trim() {
  local s=$1
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# resolve_socket <spec>: sets TMUX_ARGS (always non-empty on success) or
# fails with SOCKET_ERROR. spec: pi (default) | default | current. Mirrors
# normalizeSocket in ../sockets.ts. Absolute paths are rejected.
resolve_socket() {
  local spec
  spec=$(trim "${1:-}")
  SOCKET_ERROR=""
  case $spec in
    ''|pi)
      TMUX_ARGS=(-S "$SOCKET")
      ;;
    default)
      TMUX_ARGS=(-L default)
      unset TMUX
      ;;
    current)
      if [ -z "${TMUX:-}" ]; then
        SOCKET_ERROR="socket \"current\" requested but \$TMUX is unset — use pi|default"
        TMUX_ARGS=()
        return 1
      fi
      TMUX_ARGS=(-S "${TMUX%%,*}")
      ;;
    *)
      SOCKET_ERROR="invalid socket \"$spec\" — use pi|default|current"
      TMUX_ARGS=()
      return 1
      ;;
  esac
  return 0
}

# resolve_pane <target>: sets PANE_ID (a %N id) and RESOLVED_TARGET
# (canonical sess:win.pane) or fails with SOCKET_ERROR. Grammar:
# sess | sess:win | sess:win.pane | %N. Requires TMUX_ARGS from resolve_socket.
# The user string never reaches tmux -t; capture uses the resolved %N.
resolve_pane() {
  local t
  t=$(trim "${1:-}")
  SOCKET_ERROR=""
  PANE_ID=""
  RESOLVED_TARGET=""

  if [ -z "$t" ]; then SOCKET_ERROR="empty target"; return 1; fi
  if [ ${#t} -gt 256 ]; then SOCKET_ERROR="target too long (max 256)"; return 1; fi
  if printf '%s' "$t" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    SOCKET_ERROR="invalid target — control characters"; return 1
  fi

  local rows
  rows=$(tmux "${TMUX_ARGS[@]}" list-panes -a \
    -F '#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{window_active}|#{pane_active}' \
    2>/dev/null) || rows=""

  # pane id: must appear verbatim in the enumeration
  if [ "${t#%}" != "$t" ]; then
    case $t in
      %*[!0-9]*|%) SOCKET_ERROR="invalid pane id \"$t\""; return 1 ;;
    esac
    PANE_ID=$(printf '%s\n' "$rows" | want="$t" awk -F'|' '$4==ENVIRON["want"] { print $4; exit }')
    if [ -z "$PANE_ID" ]; then SOCKET_ERROR="no pane \"$t\" on socket"; return 1; fi
    RESOLVED_TARGET=$(printf '%s\n' "$rows" | awk -F'|' -v want="$PANE_ID" '$4==want { print $1":"$2"."$3; exit }')
    return 0
  fi

  local hit
  # exact pane key sess:win.pane
  hit=$(printf '%s\n' "$rows" | want="$t" awk -F'|' '{ key=$1":"$2"."$3; if (key==ENVIRON["want"]) print $4 }')
  if [ -n "$hit" ]; then
    if [ "$(printf '%s\n' "$hit" | wc -l | tr -d ' ')" -gt 1 ]; then
      SOCKET_ERROR="ambiguous target \"$t\" — use sess:win.pane"; return 1
    fi
    PANE_ID=$hit
    RESOLVED_TARGET=$(printf '%s\n' "$rows" | awk -F'|' -v want="$PANE_ID" '$4==want { print $1":"$2"."$3; exit }')
    return 0
  fi

  # window key sess:win -> active pane in that window
  hit=$(printf '%s\n' "$rows" | want="$t" awk -F'|' '{ key=$1":"$2; if (key==ENVIRON["want"] && $6==1) print $4 }')
  if [ -n "$hit" ]; then
    if [ "$(printf '%s\n' "$hit" | wc -l | tr -d ' ')" -gt 1 ]; then
      SOCKET_ERROR="ambiguous target \"$t\" — use sess:win.pane"; return 1
    fi
    PANE_ID=$hit
    RESOLVED_TARGET=$(printf '%s\n' "$rows" | awk -F'|' -v want="$PANE_ID" '$4==want { print $1":"$2"."$3; exit }')
    return 0
  fi

  # bare session -> active pane of the active window
  hit=$(printf '%s\n' "$rows" | want="$t" awk -F'|' '{ if ($1==ENVIRON["want"] && $5==1 && $6==1) print $4 }')
  if [ -n "$hit" ]; then
    if [ "$(printf '%s\n' "$hit" | wc -l | tr -d ' ')" -gt 1 ]; then
      SOCKET_ERROR="ambiguous target \"$t\" — use sess:win.pane"; return 1
    fi
    PANE_ID=$hit
    RESOLVED_TARGET=$(printf '%s\n' "$rows" | awk -F'|' -v want="$PANE_ID" '$4==want { print $1":"$2"."$3; exit }')
    return 0
  fi

  SOCKET_ERROR="no pane \"$t\" on socket"; return 1
}
