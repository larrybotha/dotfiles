#!/bin/sh
# Docker entrypoint: dispatches ascii or svg rendering.
# Usage:
#   entrypoint.sh ascii [--theme theme] /input/diagram.mmd
#   entrypoint.sh svg   [--theme theme] /input/diagram.mmd /output/diagram.svg -p /tmp/puppeteer.json
set -e

MODE="${1:-}"
shift

case "$MODE" in
ascii)
  exec node /usr/local/bin/ascii-preview.mjs "$@"
  ;;
svg)
  # @mermaid-js/mermaid-cli binary is mmdc
  exec mmdc "$@"
  ;;
*)
  echo "Usage: entrypoint.sh {ascii|svg} [args...]" >&2
  exit 1
  ;;
esac

