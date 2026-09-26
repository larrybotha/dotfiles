#!/usr/bin/env bash
# Open an XState machine in the Stately visualiser (local browser).
#
# Usage:
#   viz.sh [--no-open] <machine file> [port]   # start inspector + open browser
#   viz.sh status [port]                       # is inspector running?
#   viz.sh stop [port]                         # stop inspector
#
# Machine file: XState v5 machine (any named export, default export, or a
# raw machine config object). If its own directory can resolve
# xstate/@statelyai/inspect, it runs in place (so app imports work);
# otherwise it is copied into the sandbox (imports beyond xstate fail).

set -euo pipefail

SANDBOX="${XSTATE_VIZ_SANDBOX:-$HOME/.cache/xstate-viz}"
DEFAULT_PORT=8080
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
META="$SANDBOX/meta"

ensure_sandbox() {
  if [[ ! -d "$SANDBOX/node_modules/tsx" ]]; then
    echo "==> bootstrapping sandbox at $SANDBOX (first run, needs network)"
    mkdir -p "$SANDBOX"
    (cd "$SANDBOX" && npm init -y >/dev/null 2>&1 && npm install --silent --no-audit --no-fund xstate @statelyai/inspect tsx)
  fi
}

cmd_start() {
  local machine_path="${1:?usage: viz.sh [--no-open] <machine file> [port]}"
  local port="${2:-$DEFAULT_PORT}"
  local open="${OPEN:-1}"

  machine_path="$(cd "$(dirname "$machine_path")" && pwd)/$(basename "$machine_path")"
  [[ -f "$machine_path" ]] || { echo "error: no such file: $machine_path" >&2; exit 1; }

  # already running this machine? just (re)open the browser
  if [[ -f "$META" ]] && nc -z localhost "$port" >/dev/null 2>&1 \
     && [[ "$(sed -n 1p "$META")" == "$machine_path" ]]; then
    echo "==> already running this machine: http://localhost:$port"
    if [[ "$open" == "1" ]] && command -v open >/dev/null 2>&1; then
      open "http://localhost:$port"
    fi
    return 0
  fi

  ensure_sandbox

  # stop any previous instance (one inspector at a time)
  "$0" stop "$port" >/dev/null 2>&1 || true

  local mdir runner run_machine
  mdir="$(dirname "$machine_path")"

  if [[ -d "$mdir/node_modules/xstate" && -d "$mdir/node_modules/@statelyai/inspect" ]]; then
    # run in place: machine's own node_modules (and app imports) resolve
    runner="$mdir/.xstate-viz.runner.mjs"
    run_machine="$machine_path"
    cp "$SKILL_DIR/scripts/runner.mjs" "$runner"
  else
    # run from sandbox: only xstate/@statelyai/inspect resolvable
    runner="$SANDBOX/runner.mjs"
    rm -f "$SANDBOX"/machine.ts "$SANDBOX"/machine.mjs "$SANDBOX"/machine.js "$SANDBOX"/machine.cjs
    cp "$machine_path" "$SANDBOX/machine.${machine_path##*.}"
    run_machine="$SANDBOX/machine.${machine_path##*.}"
    cp "$SKILL_DIR/scripts/runner.mjs" "$runner"
  fi

  printf '%s\n%s\n' "$machine_path" "$runner" > "$META"

  echo "==> starting inspector on port $port (machine: $machine_path)"
  (cd "$(dirname "$runner")" && OPEN="$open" nohup "$SANDBOX/node_modules/.bin/tsx" "$runner" "$run_machine" "$port" "$open" \
    > "$SANDBOX/inspector.log" 2>&1 & echo $! > "$SANDBOX/pid")

  for _ in $(seq 1 30); do
    nc -z localhost "$port" >/dev/null 2>&1 && break
    if ! kill -0 "$(cat "$SANDBOX/pid")" >/dev/null 2>&1; then
      echo "error: runner died, log:" >&2; tail -20 "$SANDBOX/inspector.log" >&2; exit 1
    fi
    sleep 0.5
  done
  nc -z localhost "$port" >/dev/null 2>&1 || { echo "error: server not listening on $port" >&2; tail -20 "$SANDBOX/inspector.log" >&2; exit 1; }

  echo "==> inspector: http://localhost:$port  (log: $SANDBOX/inspector.log)"
  [[ "$open" != "1" ]] && echo "==> open manually: http://localhost:$port"
  echo "==> stop with: $0 stop $port"
}

case "${1:-}" in
  --no-open) shift; OPEN=0; cmd_start "$@" ;;
  stop)
    port="${2:-$DEFAULT_PORT}"
    pidfile="$SANDBOX/pid"
    if [[ -f "$pidfile" ]]; then
      pid="$(cat "$pidfile")"
      kill "$pid" >/dev/null 2>&1 && echo "==> stopped (pid $pid)" || echo "==> not running"
      rm -f "$pidfile"
    fi
    # belt and braces: free the port regardless
    local_pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    [[ -n "$local_pids" ]] && kill $local_pids >/dev/null 2>&1 || true
    # clean up in-place runner + meta if present
    if [[ -f "$META" ]]; then
      rpath="$(sed -n 2p "$META")"
      [[ -n "$rpath" && "$rpath" != "$SANDBOX/runner.mjs" ]] && rm -f "$rpath"
      rm -f "$META"
    fi
    ;;
  status)
    port="${2:-$DEFAULT_PORT}"
    if nc -z localhost "$port" >/dev/null 2>&1; then
      echo "running: http://localhost:$port"
    else
      echo "not running"
    fi
    ;;
  -h|--help|help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) cmd_start "$@" ;;
esac
