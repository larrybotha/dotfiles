#!/usr/bin/env bash

function ensure_has_nix() {
	if ! type -p nix &>/dev/null; then
		echo "installing nix"

    curl -L https://nixos.org/nix/install | sh -s -- --daemon
	fi
}

ensure_has_nix

packages=(
  alejandra # formatter
  deadnix # diagnostics

  just # task runner
  nushell # shell
)

nix-env -i "${packages[@]}"
