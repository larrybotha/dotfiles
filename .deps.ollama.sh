#!/usr/bin/env bash

function ensure_ollama() {
  if ! command -v ollama &>/dev/null; then
    SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"

    echo "ollama not found... not installing models"
    echo "Please install Ollama and run this script again: $SCRIPT_PATH"

    exit
  fi
}

ensure_ollama

models=(
  qwen2.5-coder:7b
  deepseek-r1:8b
)

for model in "${models[@]}"; do
  ollama pull "$model"
done
