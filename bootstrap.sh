#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE}")"
git pull origin master

function doIt() {
  rsync --exclude ".git/" \
    --exclude ".DS_Store" \
    --exclude "bootstrap.sh" \
    --exclude "README.md" \
    --exclude "Makefile" \
    --exclude ".vimrc" \
    --exclude ".vim" \
    --exclude ".config" \
    --exclude ".tmux.conf" \
    --exclude "LICENSE-MIT.txt" -av --no-perms . ~

  # add npm script completion
  if type "npm" > /dev/null; then
    npm completion >> ~/.shrc
  fi

  if [ "$SHELL" == "/bin/zsh" ]; then
    zsh ~/.zshrc
  else
    source ~/.bash_profile
  fi

  linkScripts
}

function linkScripts() {
  echo ""
  configs=(
    ".vimrc"
    ".vim"
    ".tmux.conf"
    ".config/alacritty"
    ".config/karabiner"
    ".config/kitty"
    ".config/nvim"
    ".config/skhd"
    ".config/yabai"
  )

  for config in "${configs[@]}"
  do
    user_path=$HOME/$config
    config_path=$PWD/$config

    if [ ! -e "$user_path" ]; then
      echo "linking: ~/$config -> $config"
      folder=${user_path%/*}
      mkdir -p $folder
      ln -s $config_path $user_path
    elif [ -L "$user_path" ]; then
      echo "linked: ~/$config -> ./$config"
    else
      echo "not linked: ~/$config -> ./$config"
      echo "   => consider removing ~/$config"
    fi
  done
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
