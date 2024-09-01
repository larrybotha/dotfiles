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

# https://github.com/git/git/blob/master/contrib/completion/git-completion.bash
# Autocomplete motherflippin' git branches
if [ ! -d ~/code/git-completion ]; then
	mkdir ~/code/git-completion
fi
pushd ~/code/git-completion/ >/dev/null
curl https://raw.github.com/git/git/master/contrib/completion/git-completion.bash -OL
chmod -X ~/code/git-completion/git-completion.bash
popd

# git-completion binary is already referenced from .shrc
