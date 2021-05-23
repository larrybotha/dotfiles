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

  # append npm script completion
  if type "npm" >/dev/null; then
    npm completion >>~/.sh_completion
  fi

  if [ "$SHELL" == "/bin/zsh" ]; then
    zsh ~/.zshrc
  else
    source ~/.bash_profile
  fi

  linkScripts
  copyFiles
}

function linkScripts() {
  echo ""
  configs=(
    ".vimrc"
    ".vim"
    ".tmux.conf"
    ".config/alacritty"
    ".config/asynctasks"
    ".config/karabiner"
    ".config/kitty"
    ".config/nvim"
    ".config/ptpython"
    ".config/skhd"
    ".config/tmuxinator"
    ".config/yabai"
  )

  for config in "${configs[@]}"; do
    user_path=$HOME/$config
    config_path=$PWD/$config

    if [ ! -e "$user_path" ]; then
      echo -e "linking: ~/$config -> $config"
      folder=${user_path%/*}
      mkdir -p $folder
      ln -s $config_path $user_path
    elif [ -L "$user_path" ]; then
      echo -e "linked: ~/$config -> ./$config"
    else
      echo -e "not linked: ~/$config -> ./$config"
      echo -e "\t=> consider removing ~/$config"
    fi
  done
}

# TODO: use symlinks for this to prevent having to source bootstrap.sh when
# changes are made
function copyFiles() {
  echo ""
  configs=(
    "
      vimspector-global-config.json
      $PWD/.vim/local/plugins/vimspector
      $HOME/.vim/plugged/vimspector/configurations/macos/_all
    "
  )

  for config in "${configs[@]}"; do
    set -- $config
    file_name=$1
    source_file=$2/$file_name
    dest_file=$3/$file_name

    if [ ! -d "$2" ]; then
      echo -e "creating folder: $dest_path"
      mkdir -p $dest_path
    fi

    if [ ! -e "$dest_file" ]; then
      echo -e "copying: $source_file \n\t-> $dest_file"
      cp $source_file $dest_file
    else
      echo -e "replacing: $source_file \n\t-> $dest_file"
      cp -f $source_file $dest_file
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

unset doIt copyFiles linkScripts
