#! /usr/bin/env bash

# tmux only sources .bashrc, so we need to source .bash_profile manually
[[ -n "$PS1" && -z $TMUX ]] && source "$HOME"/.bash_profile

if type zoxide >/dev/null; then
  eval "$(zoxide init bash)"
else
  echo "zoxide not installed: ${BASH_SOURCE[0]}"
fi

export NVM_DIR="$HOME/.nvm"

[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

[ -f ~/.fzf.bash ] && source "$HOME"/.fzf.bash

if type starship >/dev/null; then
  eval "$(starship init bash)"
fi

