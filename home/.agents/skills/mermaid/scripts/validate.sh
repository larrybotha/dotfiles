#!/bin/bash
# Validate and render Mermaid diagrams in Docker.
# Uses Alpine + Chromium image (cached after first build).
#
# Usage: validate.sh [-t theme] diagram.mmd [output.svg]
#   -t theme   Mermaid theme (default|dark|forest|neutral). Default: dark
#
# Reads MERMAID_THEME env var if -t is omitted.
set -euo pipefail

THEME="${MERMAID_THEME:-dark}"
while getopts "t:" opt; do
  case "$opt" in
  t) THEME="$OPTARG" ;;
  *)
    echo "Usage: $0 [-t theme] diagram.mmd [output.svg]" >&2
    exit 1
    ;;
  esac
done
shift $((OPTIND - 1))

if [ $# -lt 1 ]; then
  echo "Usage: $0 [-t theme] diagram.mmd [output.svg]" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="${2:-}"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 1
fi

# Resolve absolute paths
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
INPUT_DIR="$(dirname "$INPUT_ABS")"

# Puppeteer config for Alpine Chromium (no sandbox)
PUPPETEER_CFG="$(mktemp)"
echo '{"args":["--no-sandbox","--disable-setuid-sandbox"]}' >"$PUPPETEER_CFG"

if [ "$OUTPUT" != "" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
  OUTPUT_ABS="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
  OUTPUT_DIR="$(dirname "$OUTPUT_ABS")"
else
  OUTPUT_ABS="$(mktemp /tmp/mermaid_validate.XXXXXX.svg)"
  OUTPUT_DIR="$(dirname "$OUTPUT_ABS")"
fi

cleanup() {
  rm -f "$PUPPETEER_CFG"
  if [ "$OUTPUT" = "" ]; then
    rm -f "$OUTPUT_ABS"
  fi
}
trap cleanup EXIT

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="pi-mermaid-validate"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

echo "Validating: $INPUT"

if ! docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input \
  --mount type=bind,source="$OUTPUT_DIR",target=/output \
  --mount type=bind,source="$PUPPETEER_CFG",target=/tmp/puppeteer.json \
  "$IMAGE_NAME" \
  -a \
  -i "/input/$(basename "$INPUT_ABS")" \
  -o "/output/$(basename "$OUTPUT_ABS")" \
  -p /tmp/puppeteer.json \
  -t "$THEME" \
  -q; then
  echo "✗ Mermaid validation failed"
  exit 1
fi

if [ "$OUTPUT" != "" ]; then
  echo "Rendered to: $OUTPUT_ABS"
fi

