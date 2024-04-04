#!/usr/bin/env bash

function _install_python_package() {
	local package="$1"

	rye install --force "$package"
}

python3 -m pip install --upgrade pip

# add python support for neovim
python2 -m pip install --user --upgrade pynvim
python3 -m pip install --user --upgrade pynvim

if ! type -p "rye" >/dev/null; then
	echo "Please install rye before running this script"
	exit 1
fi

packages=(
	# Once python is installed, via homebrew, we have pip and Distribute. Let's ensure
	# we can work in virtual environments, too
	# http://docs.python-guide.org/en/latest/starting/install/osx/
	virtualenv
	pipenv

	# diagnostics, linting, lsp, formatters
	autoimport  # formatter
	codespell   # diagnostics
	djlint      # formatter / diagnostics
	ruff        # formatter / diagnostics
	ruff-lsp    # LSP
	yamllint    # diagnostics

	ptpython # better REPL

	epy-reader # reading epubs
)

for package in "${packages[@]}"; do
	_install_python_package "$package"
done

# ChatGPT
#
# Install via pip because it currently does not install via rye
python3 -m pip install --user --upgrade gpt-command-line
