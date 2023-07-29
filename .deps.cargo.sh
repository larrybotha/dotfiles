#!/usr/bin/env bash

function ensure_has_rust() {
	if type -p cargo &>/dev/null; then
		echo "Rust already installed"
	else
		echo "installing Rust"

		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
	fi
}

ensure_has_rust

cargo install evcxr # repl
cargo install git-stack # tool for visualising and working with stacked Git branches

# diagnostics, linting, lsp, formatters
cargo install blackd-client  # formatter
cargo install cbfmt          # formatter
cargo install dotenv-linter  # diagnostics
cargo install selene         # diagnostics
cargo install shellharden    # formatter
cargo install taplo-cli      # formatter + diagnostics
