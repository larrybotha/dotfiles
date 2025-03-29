#!/usr/bin/env bash

cd "$(dirname "${BASH_SOURCE[0]}")" || exit
git pull origin master

function heading() {
	local divider="==================================="
	echo -e "\n$divider"
	echo -e "  $*"
	echo "$divider"
}

function log {
	echo -e "$*"
}

function has_internet_access() {
	ping -c 1 -q google.com >&/dev/null
}

function copy_files() {
	heading "syncing dotfiles"

	files=(
		".sh_completion" # allows for completion to be written after copying
	)

	source_dir="."
	destination_dir="$HOME"

	for file in "${files[@]}"; do
		rm -f "${destination_dir}/${file}"
		rsync -avz "${source_dir}/${file}" "${destination_dir}/"
	done
}

function source_shell() {
	heading "sourcing ${SHELL}"

	if [ "$SHELL" == "/bin/zsh" ]; then
		zsh ~/.zshrc
	else
		source "$HOME/.bash_profile"
	fi

	log 'done'
}

function symlink_to_home() {
	heading "symlinking configs"

	local configs=(
		".aliases"
		".bash_profile"
		".bashrc"
		".cbfmt.toml"
		".config"
		".cursor"
		".exports"
		".functions"
		".gitattributes"
		".gitconfig"
		".gitignore"
		".hushlogin"
		".ignore"
		".inputrc"
		".osx"
		".path"
		".screenrc"
		".sh_prompt"
		".shrc"
		".tmux"
		".tmux.conf"
		".tmux-powerlinerc"
		".vim"
		".vimrc"
		".wgetrc"
		".zsh_completion"
		".zshrc"
		"init"
	)

	local script_dir
	script_dir="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"

	for config in "${configs[@]}"; do
		local source_path="$script_dir/$config"
		local dest_path="$HOME/$config"

		if [ ! -e "$dest_path" ]; then
			log "linking: ~/$config -> $config"
			local folder="${dest_path%/*}"
			mkdir -p "$folder"
			ln -s "$source_path" "$dest_path"
		elif [ -L "$dest_path" ]; then
			log "linked: ./$config -> ~/$config"
		else
			log "not linked: ~/$config -> ./$config\n\t=> consider removing ~/$config"
		fi
	done
}

function symlink_files() {
	heading "symlinking files"

	function link_file() {
		local file_name=$1
		local source_path=$2
		local dest_path=$3
		local source_file="$source_path/$file_name"
		local dest_file="$dest_path/$file_name"

		mkdir -p "$dest_path"

		if [ ! -e "$dest_file" ]; then
			log "linking: $source_file -> $dest_file"
			ln -s "$source_file" "$dest_file"
		elif [ -L "$dest_file" ]; then
			log "linked: $source_file\n\t-> $dest_file"
		else
			log "not linked: $source_file -> $dest_file\n\t=> consider removing $dest_file"
		fi
	}

	local script_dir
	script_dir="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"

	local vimspector_config=(
		"vimspector-global-config.json"
		"${script_dir}/.vim/local/plugins/vimspector"
		"${HOME}/.vim/plugged/vimspector/configurations/macos/_all"
	)
	local lazygit_config=(
		"config.yml"
		"${script_dir}/.config/lazygit"
		"${HOME}/Library/Application Support/lazygit"
	)
	local prettierrc_config=(
		".prettierrc.cjs"
		"$script_dir"
		"${HOME}/.local/share/nvim/prettierd"
	)

	link_file "${vimspector_config[@]}"
	link_file "${lazygit_config[@]}"
	link_file "${prettierrc_config[@]}"
}

function update_nnn_plugins() {
	symlink_custom_nnn_plugins() {
		local nnn_configs_path=${HOME}/.config/nnn
		local source=${nnn_configs_path}/custom/plugins
		local symlink=${nnn_configs_path}/plugins/personal

		if [ ! -e "$symlink" ]; then
			heading "symlinking custom nnn plugins"

			ln -s "$source" "$symlink"
			log 'done'
		fi
	}

	heading "updating nnn plugins"

	log 'removing existing nnn plugins'
	rm -rf "$HOME/.config/nnn/plugins"

	log 'updating nnn plugins'
	curl -Ls https://raw.githubusercontent.com/jarun/nnn/master/plugins/getplugs | sh

	symlink_custom_nnn_plugins
}

function do_it() {
	copy_files
	symlink_to_home
	symlink_files
	has_internet_access && update_nnn_plugins
	source_shell
}

if [ "$1" == "--force" ] || [ "$1" == "-f" ]; then
	do_it
else
	read -rp "This may overwrite existing files in your home directory. Are you sure? (y/n) " -n 1
	echo
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		do_it
	fi
fi

unset do_it \
	symlink_files \
	symlink_configs \
	update_nnn_plugins \
	log heading
