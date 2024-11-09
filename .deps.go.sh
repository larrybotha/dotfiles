#!/usr/bin/env bash

function ensure_has_go() {
	if type -p go &>/dev/null; then
		echo "Go already installed"
	else
    brew install go
	fi
}

ensure_has_go

go install github.com/x-motemen/gore/cmd/gore@latest # repl
