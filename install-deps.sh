#!/usr/bin/env zsh

# homebrew!
# you need the code CLI tools YOU FOOL.
ruby <(curl -fsSkL raw.github.com/mxcl/homebrew/go)

./.deps.rust.sh
./.deps.brew.sh
./.deps.node.sh
./.deps.python.sh
./.deps.nix.sh

# make a code directory for dependencies
if [ ! -d ~/code ]; then
	mkdir ~/code
fi
