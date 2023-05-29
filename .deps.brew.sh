#!/usr/bin/env bash

# Make sure we’re using the latest Homebrew
brew update

# Upgrade any already-installed formulae
brew upgrade

# Install Mojave deps
brew install openldap libiconv

# Install GNU core utilities (those that come with OS X are outdated)
brew install coreutils
echo "Don’t forget to add $(brew --prefix coreutils)/libexec/gnubin to \$PATH."

# Install GNU `find`, `locate`, `updatedb`, and `xargs`, g-prefixed
brew install findutils

# Install Bash 4
brew install bash

# Install wget with IRI support
brew install wget --enable-iri

# Install RingoJS and Narwhal
# Note that the order in which these are installed is important; see http://git.io/brew-narwhal-ringo.
brew install ringojs
brew install narwhal

brew tap homebrew/services

# Install rbenv for Ruby version management
# eval "$(rbenv init -)" is already added in .bash_profile
brew install rbenv ruby-build

# Install MySQL so we can run mysql commands from the host
brew install mysql

# Install other useful binaries
brew install ack
brew install ansible
brew install ansible-lint
brew install atuin
brew install bat
brew install checkov
brew install checkmake
brew install codespell
brew install ctop
brew install deno
brew install dive
brew install dust
brew install editorconfig
brew install elasticsearch
brew install exa
brew install fcp
brew install fd
brew install flow
brew install fluent-bit
brew install fzf
brew install git
brew install git-crypt
brew install git-delta
brew install git-flow
brew install gitlab-runner
brew install go
brew install gopls
brew install hadolint # linter for Dockerfiles
brew install howdoi   # linter for Dockerfiles
brew install htop
brew install hub
brew install jesseduffield/lazydocker/lazydocker
brew install jesseduffield/lazynpm/lazynpm
brew install jq
brew install lazygit
brew install lulu
brew install lynx
brew install markdown-toc
brew install markdownlint-cli2
brew install mosh
brew install neovim
brew install nnn
brew install nvm
brew install pigz
brew install fsouza/prettierd/prettierd
brew install pipenv
brew install postgresql
brew install pyenv
brew install pyenv-virtualenv
brew install python
brew install qt
brew install redis
brew install rename
brew install ripgrep
brew install rust-analyzer
brew install sbt
brew install shellcheck
brew install shfmt
brew install sqlfluff
brew install tealdeer
brew install terraform
brew install the_silver_searcher
brew install tmuxinator
brew install tre-command
brew install vim
brew install vint
brew install vivid
brew install vulture
brew install watch
brew install watchman
brew install webkit2png
brew install xh # httpie alternative
brew install xplr
brew install yarn
brew install zopfli
brew install zoxide

# lua
brew tap homebrew/versions
brew install lua
brew install lua-language-server
brew install stylua
brew install selene

# patched fonts
brew tap homebrew/cask-fonts
brew install --cask font-roboto-mono-nerd-font

# Hashicorp Packer
brew tap hashicorp/tap
brew install hashicorp/tap/packer

# linting and lsp language server deps
brew install ninja
brew install hashicorp/tap/terraform-ls
brew install tflint

# tmux and dependencies
brew install tmux
brew install reattach-to-user-namespace

# Install yabai deps
brew install koekeishiya/formulae/yabai
brew install koekeishiya/formulae/skhd
brew install hammerspoon

function install_cask() {
	if brew info "${@}" | grep "Not installed" >/dev/null; then
		brew install "${@}"
	else
		echo "${*} is already installed."
	fi
}

if [ "$(uname -s)" == "Darwin" ]; then
	casks=(
		a-better-finder-rename
		alacritty
		alfred
		anki
		beekeeper-studio
		betterzip
		brave-browser
		dash
		dbgate
		dbvisualizer
		docker
		dropbox
		figma
		firefox
		flameshot
		flux
		google-chrome
		google-cloud-sdk
		homebrew/cask-versions/firefox-developer-edition
		imagealpha
		imageoptim
		integrity
		iterm2
		kap
		karabiner-elements
		keycastr
		libreoffice
		moom
		mysqlworkbench
		postman
		proxyman
		qlImageSize
		qlcolorcode
		qlmarkdown
		qlstephen
		qlvideo
		quicklook-csv
		quicklook-json
		rescuetime
		robo-3t
		safari-technology-preview
		skype
		slack
		sourcetree
		the-unarchiver
		transmission
		virtualbox
		visual-studio-code
		vlc
		webpquicklook
		xbar
		xscope
	)

	for cask in "${casks[@]}"; do
		install_cask "$cask"
	done
fi

# Remove outdated versions from the cellar
brew cleanup
