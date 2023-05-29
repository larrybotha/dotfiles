# tmux only sources .bashrc, so we need to source .bash_profile manually
[[ -n "$PS1" && -z $TMUX ]] && source ~/.bash_profile

if type zoxide >/dev/null; then
  # enable zoxide
  eval "$(zoxide init bash)"
else
  echo "zoxide not installed: $BASH_SOURCE"
fi

export NVM_DIR="/Users/larrybotha/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

[ -f ~/.fzf.bash ] && source ~/.fzf.bash
