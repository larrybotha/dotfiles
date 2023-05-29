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

cargo install cbfmt
cargo install deno_lint
cargo install dotenv-linter
cargo install evcxr
cargo install selene
cargo install shellharden
cargo install taplo-cli
