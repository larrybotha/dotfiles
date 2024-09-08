#!/usr/bin/env bash

function ensure_has_nvm() {

	# install Node Version Manager and node
	if type -p nvm &>/dev/null; then
		echo "nvm already installed"
	else
		echo "installing nvm"

		curl https://raw.githubusercontent.com/creationix/nvm/v0.24.0/install.sh | bash
	fi
}

function ensure_has_node() {
	if type -p node &>/dev/null; then
		echo "node already installed"
	else
		echo "installing node"

		nvm install node
	fi
}

ensure_has_nvm
ensure_has_node

update_existing=false

if [ "$1" == --update-existing ] || [ "$1" == '-u' ]; then
	update_existing=true
fi

function is_installed() {
	if npm list -g "${@}" | grep "empty" >/dev/null; then
		echo false
	else
		echo true
	fi
}

function install_module() {
	installed=$(is_installed "${@}")
	message="updating"

	if test "$installed" != true; then
		message="installing"
	fi

	echo '-----------------------------------------------'
	echo -e "  ${*}: $message..."
	echo '-----------------------------------------------'

	npm install -g "${@}"

	echo ""
}

function conditional_install() {
	local module="$1"
	local update_existing="$2"
	local installed
	installed=$(is_installed "$module")

	if test "$installed" == 'true' && test "$update_existing" != 'true'; then
		echo "$module already installed - skipping"
	else
		install_module "$module"
	fi
}

# TODO: use GNU parallel to speed up installation of these deps
common_modules=(
	fast-cli
	imageoptim-cli
	localtunnel
	ndb
	neovim
	ngrok
	nodemon
	server
	typescript
	yo

	# diagnostics, linting, lsp, formatters
	alex                    # diagnostics
	eslint_d                # formatter / diagnostics
	fixjson                 # formatter
	jsonlint                # diagnostics
	nginxbeautifier					# formatter
	prettier                # formatter
	prettier-plugin-svelte  # formatter
	stylelint               # diagnostics

	# language servers
	ansible-language-server
	bash-language-server
	dockerfile-language-server-nodejs
	eslint-language-server
	svelte-language-server
	typescript-language-server   # ts_ls in lspconfig
	vim-language-server
	vscode-langservers-extracted # css, html, json
	yaml-language-server

	# vim-imports-sort deps
	import-sort-cli
	import-sort-parser-babylon
	import-sort-parser-typescript
	import-sort-style-renke
)

mac_modules=(
	alfred-npms
	alfred-fkill
)

for module in "${common_modules[@]}"; do
	conditional_install "$module" "$update_existing"
done

if [ "$(uname -s)" = "Darwin" ]; then
	for module in "${mac_modules[@]}"; do
		conditional_install "$module" "$update_existing"
	done
fi
