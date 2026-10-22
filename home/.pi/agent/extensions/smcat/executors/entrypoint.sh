#!/bin/sh
# Docker entrypoint: dispatches text (validate -> DOT preview) or render.
# Usage:
#   entrypoint.sh text   <direction> /input/diagram.smcat
#   entrypoint.sh render <direction> /input/diagram.smcat /output/diagram.svg
#
# rc: 0 ok, 1 invalid diagram, 2 infra (unsupported extension).
set -e

MODE="${1:-}"
shift

case "$MODE" in
text)
  DIRECTION="$1"
  INPUT="$2"
  # Parse + emit DOT to stdout. smcat writes to <input>.dot by default, so
  # route it to a writable temp path (the input mount is read-only).
  # rc: 0 valid, 1 invalid diagram.
  smcat -T dot -d "$DIRECTION" -o /tmp/smcat-out.dot "$INPUT"
  cat /tmp/smcat-out.dot
  ;;
render)
  DIRECTION="$1"
  INPUT="$2"
  OUTPUT="$3"
  case "$OUTPUT" in
  *.svg) TYPE=svg ;;
  *.png) TYPE=png ;;
  *.pdf) TYPE=pdf ;;
  *)
    echo "infra: unsupported output extension: $OUTPUT (use .svg, .png, or .pdf)" >&2
    exit 2
    ;;
  esac
  exec smcat -T "$TYPE" -d "$DIRECTION" -o "$OUTPUT" "$INPUT"
  ;;
*)
  echo "Usage: entrypoint.sh {text|render} <direction> <input> [output]" >&2
  exit 2
  ;;
esac
