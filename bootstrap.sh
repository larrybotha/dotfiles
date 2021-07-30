#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE}")"
git pull origin master

function heading() {
  local divider="==================================="
  echo -e "\n${divider}"
  echo -e "  $*"
  echo ${divider}
}

function log {
  echo -e "$*"
}

function has_internet_access() {
  ping -c 1 -q google.com >&/dev/null
}

function sync_files() {
  heading "syncing dotfiles"

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
}

function prepare_completions() {
  heading "preparing completions"

  # append npm script completion
  if type "npm" >/dev/null; then
    npm completion >>~/.sh_completion
  fi

  log 'done'
}

function source_shell() {
  heading "sourcing ${SHELL}"

  if [ "$SHELL" == "/bin/zsh" ]; then
    zsh ~/.zshrc
  else
    source ~/.bash_profile
  fi

  log 'done'
}

function symlink_configs() {
  heading "symlinking configs"

  local configs=(
    ".vimrc"
    ".vim"
    ".tmux.conf"
    ".config/alacritty"
    ".config/asynctasks"
    ".config/karabiner"
    ".config/kitty"
    ".config/nnn"
    ".config/nvim"
    ".config/ptpython"
    ".config/skhd"
    ".config/tmuxinator"
    ".config/vivid"
    ".config/yabai"
  )

  for config in "${configs[@]}"; do
    local user_path=$HOME/$config
    local config_path=$PWD/$config

    if [ ! -e "$user_path" ]; then
      log "linking: ~/$config -> $config"
      local folder=${user_path%/*}
      mkdir -p $folder
      ln -s $config_path $user_path
    elif [ -L "$user_path" ]; then
      log "linked: ~/$config -> ./$config"
    else
      log "not linked: ~/$config -> ./$config\n\t=> consider removing ~/$config"
    fi
  done
}

# TODO: use symlinks for this to prevent having to source bootstrap.sh when
# changes are made
function copy_files() {
  heading "copying files"

  local configs=(
    "
      vimspector-global-config.json
      $PWD/.vim/local/plugins/vimspector
      $HOME/.vim/plugged/vimspector/configurations/macos/_all
    "
  )

  for config in "${configs[@]}"; do
    set -- $config
    local file_name=$1
    local source_file=$2/$file_name
    local dest_file=$3/$file_name

    if [ ! -d "$2" ]; then
      log "creating folder: $dest_path"
      mkdir -p $dest_path
    fi

    if [ ! -e "$dest_file" ]; then
      log "copying: $source_file \n\t-> $dest_file"
      cp $source_file $dest_file
    else
      log "replacing: $source_file \n\t-> $dest_file"
      cp -f $source_file $dest_file
    fi
  done
}

function update_nnn_plugins() {
  symlink_custom_nnn_plugins() {
    local nnn_configs_path=${HOME}/.config/nnn
    local source=${nnn_configs_path}/custom/plugins
    local symlink=${nnn_configs_path}/plugins/personal

    if [ ! -e "$symlink" ]; then
      heading "symlinking custom nnn plugins"

      ln -s $source $symlink
      log 'done'
    fi
  }

  heading "updating nnn plugins"

  log 'removing existing nnn plugins'
  rm -rf $HOME/.config/nnn/plugins

  log 'updating nnn plugins'
  curl -Ls https://raw.githubusercontent.com/jarun/nnn/master/plugins/getplugs | sh

  symlink_custom_nnn_plugins
}

function do_it() {
  sync_files
  prepare_completions
  symlink_configs
  copy_files
  has_internet_access && update_nnn_plugins
  source_shell
}

if [ "$1" == "--force" -o "$1" == "-f" ]; then
  do_it
else
  read -p "This may overwrite existing files in your home directory. Are you sure? (y/n) " -n 1
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    do_it
  fi
fi

unset do_it \
  copy_files \
  symlink_configs \
  update_nnn_plugins \
  log heading
