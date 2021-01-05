# tmux only sources .bashrc, so we need to source .bash_profile manually
[[ -n "$PS1"  && -z $TMUX ]] && source ~/.bash_profile
