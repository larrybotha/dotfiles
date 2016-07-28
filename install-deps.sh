# up to you (me) if you want to run this as a file or copy paste at your leisure


# https://github.com/jamiew/git-friendly
# the `push` command which copies the github compare URL to my clipboard is heaven
sudo bash < <( curl https://raw.github.com/jamiew/git-friendly/master/install.sh)


# homebrew!
# you need the code CLI tools YOU FOOL.
ruby <(curl -fsSkL raw.github.com/mxcl/homebrew/go)

# install node the right way
# https://gist.github.com/DanHerbert/9520689
if type -P node &> /dev/null; then
	echo "node already installed"
else
	if [ -d /usr/local/lib/node_modules ]; then
		rm -rf /usr/local/lib/node_modules
	fi

	echo "installing node"

	brew uninstall node
	brew install node --without-npm
	echo prefix=~/.node >> ~/.npmrc
	curl -L https://www.npmjs.org/install.sh | sh
fi

# install Node Version Manager
if type -P nvm &> /dev/null; then
	echo "nvm already installed"
else
	echo "installing nvm"

	curl https://raw.githubusercontent.com/creationix/nvm/v0.24.0/install.sh | bash
fi

# make a code directory for dependencies
if [ ! -d ~/code ]; then
	mkdir ~/code
fi

# https://github.com/rupa/z
# z, oh how i love you
cd ~/code
git clone https://github.com/rupa/z.git
chmod +x ~/code/z/z.sh
# also consider moving over your current .z file if possible. it's painful to rebuild :)

# z binary is already referenced from .bash_profile


# https://github.com/git/git/blob/master/contrib/completion/git-completion.bash
# Autocomplete motherflippin' git branches
if [ ! -d ~/code/git-completion ]; then
	mkdir ~/code/git-completion
fi
cd ~/code/git-completion
curl https://raw.github.com/git/git/master/contrib/completion/git-completion.bash -OL
chmod -X ~/code/git-completion/git-completion.bash

# git-completion binary is already referenced from .bash_profile


# git sub-repo
cd ~/code
if [ ! -d ~/code/git-subrepo ]; then
  git clone https://github.com/ingydotnet/git-subrepo
fi


# https://github.com/jeroenbegyn/VLCControl
# VLC Controll Script
cd ~/code
git clone git://github.com/jeroenbegyn/VLCControl.git

# setup Vundle for Vim package management - https://github.com/gmarik/vundle
git clone https://github.com/gmarik/vundle.git ~/.vim/bundle/vundle

# my magic photobooth symlink -> dropbox. I love it.
# first move Photo Booth folder out of Pictures
# then start Photo Booth. It'll ask where to put the library.
# put it in Dropbox/public

# now you can record photobooth videos quickly and they upload to dropbox DURING RECORDING
# then you grab public URL and send off your video message in a heartbeat.


# for the c alias (syntax highlighted cat)
sudo easy_install Pygments


# chrome canary as default
# on a mac you can set chrome canary as your default inside of Safari preferences :)
