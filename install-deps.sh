# up to you (me) if you want to run this as a file or copy paste at your leisure
pushd -n "$(dirname 0)" > /dev/null

# homebrew!
# you need the code CLI tools YOU FOOL.
ruby <(curl -fsSkL raw.github.com/mxcl/homebrew/go)


# install Node Version Manager and node
if type -P nvm &> /dev/null; then
	echo "nvm already installed"
else
	echo "installing nvm"

	curl https://raw.githubusercontent.com/creationix/nvm/v0.24.0/install.sh | bash

	echo "installing node"

	nvm install node
fi

# make a code directory for dependencies
if [ ! -d ~/code ]; then
	mkdir ~/code
fi


# install antigen for zsh package management
if [ ! -d ~/code/antigen ]; then
	mkdir ~/code/antigen
	curl -L git.io/antigen > ~/code/antigen/antigen.zsh
fi


# z
# https://github.com/rupa/z
# z binary is already referenced from .shrc
pushd ~/code > /dev/null
git clone https://github.com/rupa/z.git
chmod +x ~/code/z/z.sh
popd
# also consider moving over your current .z file if possible. it's painful to rebuild :)


# https://github.com/git/git/blob/master/contrib/completion/git-completion.bash
# Autocomplete motherflippin' git branches
if [ ! -d ~/code/git-completion ]; then
	mkdir ~/code/git-completion
fi
pushd ~/code/git-completion/ > /dev/null
curl https://raw.github.com/git/git/master/contrib/completion/git-completion.bash -OL
chmod -X ~/code/git-completion/git-completion.bash
popd

# git-completion binary is already referenced from .shrc
