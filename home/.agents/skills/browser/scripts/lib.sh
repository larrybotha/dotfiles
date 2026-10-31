#!/usr/bin/env bash

cli_version() {
  playwright-cli --version 2>/dev/null | head -n 1 \
    | tr -d '[:space:]' | sed 's/^v//'
}
