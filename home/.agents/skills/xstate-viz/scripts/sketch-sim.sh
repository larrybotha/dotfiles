#!/usr/bin/env bash
# Simulate an XState machine file in local Stately Sketch (browser, headless
# by default) — no real actor runs: Sketch parses the code in-browser and its
# sim engine fires transitions on click (guards auto-true for the clicked
# guard, `after` delays scheduled for real).
#
# Usage:
#   sketch-sim.sh <machine file>                       # load + start sim + screenshot
#   sketch-sim.sh <machine file> --events NEXT,NEXT    # also fire those events
#   sketch-sim.sh <machine file> --keep                # visible Chrome, left open
#   sketch-sim.sh <machine file> --shot out.png        # custom screenshot path
#
# Machine must be self-contained (only `xstate` imports resolve in Sketch).
# Sketch host: auto-started via _viz/sketch.ts (override XSTATE_SKETCH_KIT);
# stop it with: node "$XSTATE_SKETCH_KIT" stop
#
# Env: XSTATE_VIZ_SANDBOX (default ~/.cache/xstate-viz), CHROME_PATH.

set -euo pipefail

SANDBOX="${XSTATE_VIZ_SANDBOX:-$HOME/.cache/xstate-viz}"
SKETCH_KIT="${XSTATE_SKETCH_KIT:-$HOME/.pi/agent/extensions/_viz/sketch.ts}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

machine="${1:-}"
[[ -n "$machine" && -f "$machine" ]] || { echo "error: no such machine file: ${machine:-<none>}" >&2; exit 1; }
shift

ensure_sandbox() {
  mkdir -p "$SANDBOX"
  if [[ ! -f "$SANDBOX/package.json" ]]; then
    (cd "$SANDBOX" && npm init -y >/dev/null 2>&1)
  fi
  if [[ ! -d "$SANDBOX/node_modules/puppeteer-core" ]]; then
    echo "==> bootstrapping sandbox deps (first run, needs network)" >&2
    (cd "$SANDBOX" && npm install --silent --no-audit --no-fund puppeteer-core)
  fi
}

ensure_sketch_host() {
  [[ -f "$SKETCH_KIT" ]] || { echo "error: sketch host module not found: $SKETCH_KIT (set XSTATE_SKETCH_KIT)" >&2; exit 1; }
  node "$SKETCH_KIT" ensure >/dev/null
  node "$SKETCH_KIT" url
}

ensure_sandbox
host_url="$(ensure_sketch_host)"
base="${host_url%/inspect}"
echo "==> sketch host: $base (stop: node \"$SKETCH_KIT\" stop)"

cp "$SKILL_DIR/scripts/sim.mjs" "$SANDBOX/sim.mjs"
exec node "$SANDBOX/sim.mjs" "$machine" --url "$base" "$@"
