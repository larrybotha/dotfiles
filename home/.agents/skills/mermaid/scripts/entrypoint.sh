#!/bin/sh
# Docker entrypoint: runs mmdc validation, then ASCII preview if requested.
# Usage: entrypoint.sh [-a] <mmdc args...>
#   -a  Run ASCII preview after mmdc (optional)
set -e

ASCII=0
if [ "$1" = "-a" ]; then
  ASCII=1
  shift
fi

# Run mmdc with all remaining args
mmdc "$@"
MMDC_EXIT=$?

if [ $ASCII -eq 1 ] && [ $MMDC_EXIT -eq 0 ]; then
  # Extract -i arg to get input file
  INPUT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -i) INPUT="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$INPUT" ] && [ -f "$INPUT" ]; then
    echo ""
    echo "ASCII preview:"
    node /usr/local/bin/ascii-preview.mjs "$INPUT" 2>/dev/null || echo "Warning: ASCII preview failed"
  fi
fi

exit $MMDC_EXIT