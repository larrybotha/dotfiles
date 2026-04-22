#!/bin/bash
# Validate slide-deck HTML using html5lib parser in Docker.
# Mirrors browser DOM construction — catches misnested elements.
# Usage: validate.sh OUTPUT.html
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <file.html>" >&2
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
IMAGE_NAME="pi-slide-deck-validate"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

echo "Validating: $INPUT"

docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  "$IMAGE_NAME" \
  "/input/$(basename "$INPUT_ABS")"
