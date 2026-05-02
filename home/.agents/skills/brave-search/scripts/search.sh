#!/bin/bash
# Web search via Brave Search API (Docker).
# Usage: search.sh <query> [-n <num>] [--content] [--country <code>] [--freshness <period>]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <query> [-n <num>] [--content] [--country <code>] [--freshness <period>]" >&2
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_NAME="pi-brave-search"

# Build image if not cached
if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building Docker image (first run only)..." >&2
  docker build -t "$IMAGE_NAME" -f "$SKILL_DIR/Dockerfile" "$SKILL_DIR" >&2
fi

# API key from pass — never stored in image, shell profile, or dotfiles
BRAVE_API_KEY="$(pass brave-search/api-key/pi)"

docker run --rm \
  -e "BRAVE_API_KEY=${BRAVE_API_KEY}" \
  "$IMAGE_NAME" \
  /usr/local/bin/brave-search.js "$@"
