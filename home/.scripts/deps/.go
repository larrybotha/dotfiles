#!/usr/bin/env bash

packages=(
  github.com/x-motemen/gore/cmd/gore@latest # repl
)

function ensure_has_go() {
	if type -p go &>/dev/null; then
		echo "Go already installed"
	else
    brew install go
	fi
}

ensure_has_go

for package in "${packages[@]}"; do
  go install "$package"
done
