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

cargo install evcxr     # repl
cargo install git-stack # tool for visualising and working with stacked Git branches

cargo install --git https://github.com/mitsuhiko/rye rye # Python project manager

cargo install cargo-expand # prints out the expansions of macros

# diagnostics, linting, lsp, formatters
cargo install alejandra     # nix formatter. TODO: install using flakes
cargo install cbfmt         # formatter
cargo install dotenv-linter # diagnostics
cargo install mktoc         # formatter
cargo install selene        # diagnostics
cargo install shellharden   # formatter
cargo install sleek         # diagnostics for sql
cargo install taplo-cli     # formatter + diagnostics

rustup component add rustfmt
