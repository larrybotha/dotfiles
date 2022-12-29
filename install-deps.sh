#!/usr/bin/env zsh

# homebrew!
# you need the code CLI tools YOU FOOL.
ruby <(curl -fsSkL raw.github.com/mxcl/homebrew/go)

# install Node Version Manager and node
if type -p nvm &>/dev/null; then
	echo "nvm already installed"
else
	echo "installing nvm"

	curl https://raw.githubusercontent.com/creationix/nvm/v0.24.0/install.sh | bash
fi

if type -p node &>/dev/null; then
	echo "node already installed"
else
	echo "installing node"

	nvm install node
fi

if type -p evcxr &>/dev/null; then
	echo "evcxr already installed"
elif
	! type -p cargo &
	/dev/null
then
	echo "unable to install evcxr - unable to find Rust's 'cargo' binary"
else
	echo "installing evcxr"

	cargo install evcxr
fi

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
