#!/usr/bin/env bash

function ensure_has_nix() {
	if type -p nix &>/dev/null; then
		echo "Nix is already installed"
	else
		echo "installing nix"

    curl -L https://nixos.org/nix/install | sh -s -- --daemon
	fi
}

ensure_has_nix

packages=(
  alejandra # formatter
  deadnix # diagnostics
)

nix-env -i "${packages[@]}"
