#!/bin/bash
# Validate and render Mermaid diagram as ASCII art (Docker only).
# Usage: ascii.sh [-t theme] diagram.mmd
#   -t theme   Mermaid theme (default|dark|forest|neutral). Default: dark
set -euo pipefail

THEME="${MERMAID_THEME:-dark}"
while getopts "t:" opt; do
  case "$opt" in
  t) THEME="$OPTARG" ;;
  *)
    echo "Usage: $0 [-t theme] diagram.mmd" >&2
    exit 1
    ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -lt 1 ]; then
  echo "Usage: $0 [-t theme] diagram.mmd" >&2
  exit 1
fi

INPUT="$1"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 1
fi

# Resolve absolute paths
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
INPUT_DIR="$(dirname "$INPUT_ABS")"

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="pi-mermaid-validate"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

echo "Validating: $INPUT"

docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  "$IMAGE_NAME" \
  ascii --theme "$THEME" "/input/$(basename "$INPUT_ABS")"

