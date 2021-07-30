# tmux only sources .bashrc, so we need to source .bash_profile manually
[[ -n "$PS1" && -z $TMUX ]] && source ~/.bash_profile

# enable direnv
eval "$(direnv hook bash)"

# enable zoxide
eval "$(zoxide init bash)"
