#!/usr/bin/env bash

function install_cask() {
	if brew info "${@}" | grep "Not installed" >/dev/null; then
		brew install "${@}"
	else
		echo "${*} is already installed."
	fi
}

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

# Install wget
brew install wget

brew tap homebrew/services

# Install rbenv for Ruby version management
# eval "$(rbenv init -)" is already added in .bash_profile
brew install rbenv ruby-build

# Install MySQL so we can run mysql commands from the host
brew install mysql

# Install other useful binaries
brew install ansible
brew install ansible-lint
brew install ariga/tap/atlas # Terraform-like orchestration for db schemas
brew install aldente
brew install atuin
brew install bat
brew install checkmake
brew install checkov
brew install codespell
brew install ctop
brew install difftastic
brew install dive
brew install dust
brew install editorconfig
brew install elasticsearch
brew install fd
brew install fluent-bit
brew install fzf
brew install git
brew install git-flow
brew install gitlab-runner
brew install go
brew install gopls
brew install howdoi
brew install htop
brew install jesseduffield/lazydocker/lazydocker
brew install jesseduffield/lazynpm/lazynpm
brew install jid
brew install jq
brew install keymapp
brew install lazygit
brew install lulu
brew install lynx
brew install mpv
brew install neovim
brew install nnn
brew install nvm
brew install oven-sh/bun/bun
brew install peterldowns/tap/nix-search-cli
brew install pigz
brew install pipenv
brew install postgresql
brew install pyenv
brew install pyenv-virtualenv
brew install python
brew install qt
brew install redis
brew install ripgrep
brew install starship
brew install tealdeer
brew install terraform
brew install tmuxinator
brew install tokei
brew install tre-command
brew install tursodatabase/tap/turso
brew install vim
brew install watchexec
brew install webkit2png
brew install withgraphite/tap/graphite
brew install xh # httpie alternative
brew install xplr
brew install yarn
brew install zopfli
brew install zoxide

# lua
brew tap homebrew/versions
brew install lua
brew install lua-language-server

# zig
brew install zig
brew install zls

# patched fonts
brew tap homebrew/cask-fonts
brew install --cask font-roboto-mono-nerd-font

# Hashicorp Packer
brew tap hashicorp/tap
brew install hashicorp/tap/packer

# diagnostics, linting, lsp, formatters
brew install fsouza/prettierd/prettierd  # formatter
brew install hadolint										 # diagnostics
brew install hashicorp/tap/terraf        # diagnostics
brew install markdownlint-cli2           # diagnostics
brew install rust-analyzer               # diagnostics
brew install selene                      # diagnostics
brew install shellcheck                  # diagnostics
brew install shfmt                       # formatter
brew install sqlfluff                    # formatter
brew install stylua                      # formatter
brew install vint                        # diagnostics
brew tap codeclimate/formulae						 # diagnostics
brew install codeclimate						     # diagnostics

# tmux and dependencies
brew install tmux

# Install yabai deps
brew install koekeishiya/formulae/yabai
brew install koekeishiya/formulae/skhd
brew install hammerspoon

if [ "$(uname -s)" == "Darwin" ]; then
	casks=(
		a-better-finder-rename
		alacritty
		alfred
		anki
		arc
		beekeeper-studio
		betterzip
		brave-browser
		dash
		dbgate
		dbvisualizer
		docker
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
		safari-technology-preview
		skim
		skype
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
