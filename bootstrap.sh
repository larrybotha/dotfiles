#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE}")"
git pull origin master

function doIt() {
	rsync --exclude ".git/" \
    --exclude ".DS_Store" \
    --exclude "bootstrap.sh" \
		--exclude "README.md" \
    --exclude "tags" \
    --exclude "LICENSE-MIT.txt" -av --no-perms . ~

  # copy coc-settings.json for Neovim
  cp ~/.vim/coc-settings.json ~/.config/nvim/coc-settings.json

  if [ "$SHELL" == "/bin/zsh" ]; then
    source ~/.zshrc
  else
    source ~/.bash_profile
  fi
}

if [ "$1" == "--force" -o "$1" == "-f" ]; then
	doIt
else
	read -p "This may overwrite existing files in your home directory. Are you sure? (y/n) " -n 1
	echo
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		doIt
	fi
fi

unset doIt
