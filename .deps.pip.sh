#!/usr/bin/env bash

function pip_install() {
	local package="$1"

	python -m pip install --user "$package"
}

# Once python is installed, via homebrew, we have pip and Distribute. Let's ensure
# we can work in virtual environments, too
# http://docs.python-guide.org/en/latest/starting/install/osx/
pip_install virtualenv

# add python support for neovim
python2 -m pip install --user --upgrade pynvim
python3 -m pip install --user --upgrade pynvim

# environments
pip_install pipenv

# diagnostics, linting, lsp, formatters
pip_install autoimport  # formatter
pip_install black       # formatter
pip_install codespell   # diagnostics
pip_install djlint      # formatter / diagnostics
pip_install isort       # formatter
pip_install pyflyby     # formatter
pip_install ruff        # formatter / diagnostics
pip_install ruff-lsp    # LSP
pip_install yamllint    # diagnostics

# better REPL
pip_install ptpython

# reading epubs
pip_install epy-reader
