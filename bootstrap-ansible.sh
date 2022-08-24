#!/usr/bin/env bash

set -eou pipefail

function _main() {
	if [ ! -x "$(command -v pip)" ]; then
		curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
		python get-pip.py --user
	fi

	if [ ! -x "$(command -v ansible)" ]; then
		python -m pip install --user ansible
	fi

	ansible-playbook ./dotfiles.yml --ask-become-pass

	echo "Successfully set up dev environment."
}

_main "$*"
