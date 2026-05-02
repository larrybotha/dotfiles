#!/bin/bash
# Extract readable content from a URL as markdown (Docker).
# Usage: content.sh <url>
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <url>" >&2
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="pi-brave-search"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

docker run --rm \
  "$IMAGE_NAME" \
  /usr/local/bin/brave-content.js "$@"
