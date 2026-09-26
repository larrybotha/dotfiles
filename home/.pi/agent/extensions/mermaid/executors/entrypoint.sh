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
  # Authoritative validation with mmdc (the same parser the svg render uses)
  # before the lenient beautiful-mermaid preview — a lenient preview must not
  # pass invalid syntax (dangling edges, unclosed brackets rendered fine).
  # Last argument = input file (POSIX: no ${@: -1}).
  for INPUT; do :; done
  printf '%s\n' '{"args":["--no-sandbox","--disable-setuid-sandbox"]}' >/tmp/puppeteer.json
  mmdc -i "$INPUT" -o /tmp/validate.svg -p /tmp/puppeteer.json || exit 1
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
