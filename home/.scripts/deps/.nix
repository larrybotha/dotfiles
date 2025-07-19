#!/usr/bin/env bash

function ensure_has_nix() {
  if ! type -p nix &>/dev/null; then
    echo "installing nix"

    # see https://nixcademy.com/posts/nix-on-macos/
    curl --proto '=https' --tlsv1.2 -sSf \
      -L https://install.determinate.systems/nix \
      | sh -s -- install
  fi
}

ensure_has_nix

nix-channel --update

packages=(
  alejandra # nix formatter
  deadnix # diagnostics

  just # task runner
  nushell # shell
  carapace # shell completer

  sqlite
)

for package in "${packages[@]}"; do
  nix-env -iA "$package" -f '<nixpkgs>'
done
