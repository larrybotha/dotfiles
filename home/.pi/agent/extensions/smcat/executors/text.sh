#!/bin/bash
# Validate a state-machine-cat diagram and emit its DOT source (Docker only).
# Usage: text.sh [-d direction] diagram.smcat
#   -d direction   top-down|bottom-top|left-right|right-left. Default: top-down
#
# Exit codes (executor contract):
#   0  valid (DOT source on stdout)
#   1  invalid diagram (smcat parse errors on stderr)
#   2  infra error (Docker build/run failure — the diagram is not the problem)
set -euo pipefail

DIRECTION="${SMCAT_DIRECTION:-top-down}"
while getopts "d:" opt; do
  case "$opt" in
  d) DIRECTION="$OPTARG" ;;
  *)
    echo "Usage: $0 [-d direction] diagram.smcat" >&2
    exit 2
    ;;
  esac
done
shift $((OPTIND - 1))

# Usage/file errors are caller-side, not diagram-side: exit 2 (infra), not 1.
if [ $# -lt 1 ]; then
  echo "Usage: $0 [-d direction] diagram.smcat" >&2
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

# stdout is the DOT preview (tool-facing); status goes to stderr
echo "Validating: $INPUT" >&2

set +e
docker run --rm \
  --mount type=bind,source="$INPUT_DIR",target=/input,readonly \
  "$IMAGE_NAME" \
  text "$DIRECTION" "/input/$(basename "$INPUT_ABS")"
RC=$?
set -e

case "$RC" in
0) exit 0 ;;
# docker run infra failures (daemon/mount/runtime), not diagram errors
125 | 126 | 127)
  echo "infra: docker run failed (rc=$RC)" >&2
  exit 2
  ;;
# 1 = invalid diagram (entrypoint smcat); anything else unexpected -> infra
1) exit 1 ;;
*)
  echo "infra: unexpected exit code $RC" >&2
  exit 2
  ;;
esac
