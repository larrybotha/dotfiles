#!/bin/bash
# Render Mermaid diagram as SVG or PNG using Docker (format follows the
# output file extension; mmdc infers it).
# Usage: svg.sh [-t theme] diagram.mmd output.svg|output.png
#   -t theme   Mermaid theme (default|dark|forest|neutral). Default: dark
#
# Exit codes (executor contract):
#   0  rendered
#   1  invalid diagram (mmdc parse errors on stderr)
#   2  infra error (Docker build/run failure — the diagram is not the problem)
set -euo pipefail

THEME="${MERMAID_THEME:-dark}"
while getopts "t:" opt; do
  case "$opt" in
  t) THEME="$OPTARG" ;;
  *)
    echo "Usage: $0 [-t theme] diagram.mmd output.svg" >&2
    exit 2
    ;;
  esac
done
shift $((OPTIND - 1))

# Usage/file errors are caller-side, not diagram-side: exit 2 (infra), not 1.
if [ $# -lt 2 ]; then
  echo "Usage: $0 [-t theme] diagram.mmd output.svg" >&2
  exit 2
fi

INPUT="$1"
OUTPUT="$2"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 2
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

EXEC_DIR="$(cd "$(dirname "$0")" && pwd)"
# Image tag = content hash of the executor files: editing any of them changes
# the tag -> the build below reruns automatically (no stale cached image).
# MERMAID_IMAGE overrides the whole name (prebuilt/pinned image).
if command -v shasum >/dev/null 2>&1; then
  HASH="$(cat "$EXEC_DIR/Dockerfile" "$EXEC_DIR/entrypoint.sh" "$EXEC_DIR/ascii-preview.mjs" | shasum -a 256 | cut -d' ' -f1 | cut -c1-12)"
else
  HASH="$(cat "$EXEC_DIR/Dockerfile" "$EXEC_DIR/entrypoint.sh" "$EXEC_DIR/ascii-preview.mjs" | sha256sum | cut -d' ' -f1 | cut -c1-12)"
fi
IMAGE_NAME="${MERMAID_IMAGE:-pi-mermaid-validate:$HASH}"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  if ! docker build -t "$IMAGE_NAME" -f "$EXEC_DIR/Dockerfile" "$EXEC_DIR" >&2; then
    echo "infra: docker build failed" >&2
    exit 2
  fi
fi

echo "Rendering SVG: $INPUT"

set +e
docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  --mount type=bind,source="$OUTPUT_DIR",target=/output \
  --mount type=bind,source="$PUPPETEER_CFG",target=/tmp/puppeteer.json,readonly \
  "$IMAGE_NAME" \
  svg -i "/input/$(basename "$INPUT_ABS")" \
      -o "/output/$(basename "$OUTPUT_ABS")" \
      -p /tmp/puppeteer.json \
      -t "$THEME"
RC=$?
set -e

case "$RC" in
0) ;;
# docker run infra failures (daemon/mount/runtime), not diagram errors
125 | 126 | 127)
  echo "infra: docker run failed (rc=$RC)" >&2
  exit 2
  ;;
# 1 = invalid diagram (mmdc); anything else unexpected -> infra
1)
  echo "✗ SVG rendering failed" >&2
  exit 1
  ;;
*)
  echo "infra: unexpected exit code $RC" >&2
  exit 2
  ;;
esac

echo "Rendered to: $OUTPUT_ABS"