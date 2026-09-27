#!/bin/bash
# Validate slide-deck HTML using html5lib parser in Docker.
# Mirrors browser DOM construction — catches misnested elements.
#
# Usage: validate.sh OUTPUT.html
# Exit codes (mermaid contract): 0 valid, 1 invalid deck, 2 infra
# (docker rc 125/126/127 and unexpected codes map to 2 — the deck content
# was never checked).
set -uo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <file.html>" >&2
  exit 2
fi

INPUT="$1"

if [ ! -f "$INPUT" ]; then
  echo "Error: File not found: $INPUT" >&2
  exit 2
fi

# Resolve absolute paths
INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
INPUT_DIR="$(dirname "$INPUT_ABS")"

EXEC_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="pi-slide-deck-validate"

# Always build — cached layers make this ~1s, and a changed validate.py
# invalidates only its COPY layer. (Cache-if-absent never picks up validator
# changes: the stale-image bug found during the extension migration.)
if ! docker build -q -t "$IMAGE_NAME" -f "$EXEC_DIR/Dockerfile" "$EXEC_DIR" >&2; then
  echo "Error: docker build failed for $IMAGE_NAME" >&2
  exit 2
fi

docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  "$IMAGE_NAME" \
  "/input/$(basename "$INPUT_ABS")"
RC=$?

case "$RC" in
  0) exit 0 ;;
  1) exit 1 ;;
  *)
    # 125/126/127 = docker run itself failed (daemon, image, binary); any
    # other code is unexpected — never the deck's verdict.
    echo "Error: docker run exited $RC (infra failure — the deck was NOT validated)" >&2
    exit 2
    ;;
esac
