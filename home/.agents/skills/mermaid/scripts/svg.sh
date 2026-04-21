#!/bin/bash
# Render Mermaid diagram as SVG using Docker.
# Usage: svg.sh [-t theme] diagram.mmd output.svg
#   -t theme   Mermaid theme (default|dark|forest|neutral). Default: dark
set -euo pipefail

THEME="${MERMAID_THEME:-dark}"
while getopts "t:" opt; do
  case "$opt" in
  t) THEME="$OPTARG" ;;
  *)
    echo "Usage: $0 [-t theme] diagram.mmd output.svg" >&2
    exit 1
    ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -lt 2 ]; then
  echo "Usage: $0 [-t theme] diagram.mmd output.svg" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="$2"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 1
fi

# Resolve absolute paths
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
INPUT_DIR="$(dirname "$INPUT_ABS")"

mkdir -p "$(dirname "$OUTPUT")"
OUTPUT_ABS="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
OUTPUT_DIR="$(dirname "$OUTPUT_ABS")"

# Puppeteer config for Alpine Chromium (no sandbox)
PUPPETEER_CFG="$(mktemp)"
echo '{"args":["--no-sandbox","--disable-setuid-sandbox"]}' >"$PUPPETEER_CFG"

cleanup() {
  rm -f "$PUPPETEER_CFG"
}
trap cleanup EXIT

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="pi-mermaid-validate"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

echo "Rendering SVG: $INPUT"

if ! docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  --mount type=bind,source="$OUTPUT_DIR",target=/output \
  --mount type=bind,source="$PUPPETEER_CFG",target=/tmp/puppeteer.json,readonly \
  "$IMAGE_NAME" \
  svg -i "/input/$(basename "$INPUT_ABS")" \
      -o "/output/$(basename "$OUTPUT_ABS")" \
      -p /tmp/puppeteer.json \
      -t "$THEME"; then
  echo "✗ SVG rendering failed" >&2
  exit 1
fi

echo "Rendered to: $OUTPUT_ABS"