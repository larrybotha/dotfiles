#!/bin/bash
# Render a state-machine-cat diagram to SVG, PNG, or PDF using Docker
# (format follows the output file extension).
# Usage: svg.sh [-d direction] diagram.smcat output.svg|output.png|output.pdf
#   -d direction   top-down|bottom-top|left-right|right-left. Default: top-down
#
# Exit codes (executor contract):
#   0  rendered
#   1  invalid diagram (smcat parse errors on stderr)
#   2  infra error (Docker build/run failure, unsupported extension)
set -euo pipefail

DIRECTION="${SMCAT_DIRECTION:-top-down}"
while getopts "d:" opt; do
  case "$opt" in
  d) DIRECTION="$OPTARG" ;;
  *)
    echo "Usage: $0 [-d direction] diagram.smcat output.svg" >&2
    exit 2
    ;;
  esac
done
shift $((OPTIND - 1))

# Usage/file errors are caller-side, not diagram-side: exit 2 (infra), not 1.
if [ $# -lt 2 ]; then
  echo "Usage: $0 [-d direction] diagram.smcat output.svg" >&2
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

EXEC_DIR="$(cd "$(dirname "$0")" && pwd)"
# Image tag = content hash of the executor files: editing any of them changes
# the tag -> the build below reruns automatically (no stale cached image).
# SMCAT_IMAGE overrides the whole name (prebuilt/pinned image).
if command -v shasum >/dev/null 2>&1; then
  HASH="$(cat "$EXEC_DIR/Dockerfile" "$EXEC_DIR/entrypoint.sh" | shasum -a 256 | cut -d' ' -f1 | cut -c1-12)"
else
  HASH="$(cat "$EXEC_DIR/Dockerfile" "$EXEC_DIR/entrypoint.sh" | sha256sum | cut -d' ' -f1 | cut -c1-12)"
fi
IMAGE_NAME="${SMCAT_IMAGE:-pi-smcat-validate:$HASH}"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  if ! docker build -t "$IMAGE_NAME" -f "$EXEC_DIR/Dockerfile" "$EXEC_DIR" >&2; then
    echo "infra: docker build failed" >&2
    exit 2
  fi
fi

echo "Rendering: $INPUT" >&2

set +e
docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  --mount type=bind,source="$OUTPUT_DIR",target=/output \
  "$IMAGE_NAME" \
  render "$DIRECTION" "/input/$(basename "$INPUT_ABS")" \
      "/output/$(basename "$OUTPUT_ABS")"
RC=$?
set -e

case "$RC" in
0) ;;
# docker run infra failures (daemon/mount/runtime), not diagram errors
125 | 126 | 127)
  echo "infra: docker run failed (rc=$RC)" >&2
  exit 2
  ;;
# 1 = invalid diagram (entrypoint smcat); anything else unexpected -> infra
1)
  echo "✗ render failed" >&2
  exit 1
  ;;
*)
  echo "infra: unexpected exit code $RC" >&2
  exit 2
  ;;
esac

echo "Rendered to: $OUTPUT_ABS"
