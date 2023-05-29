#!/usr/bin/env bash

function pip_install() {
	local package="$1"

	python -m pip install --user "$package"
}

# Once python is installed, via homebrew, we have pip and Distribute. Let's ensure
# we can work in virtual environments, too
# http://docs.python-guide.org/en/latest/starting/install/osx/
pip_install virtualenv

# linting
# - used by ALE
pip_install yamllint
pip_install pylint

# add python support for neovim
python2 -m pip install --user --upgrade pynvim
python3 -m pip install --user --upgrade pynvim

# environments
pip_install pipenv

# auto formatting
pip_install black

# autoformatting / autoimporting / linting
pip_install autoimport
pip_install codespell
pip_install djlint
pip_install isort
pip_install ruff

# better REPL
pip_install ptpython

# reading epubs
pip_install epy-reader
