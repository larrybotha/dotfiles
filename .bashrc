[[ -n "$PS1"  && -z $TMUX ]] && source ~/.bash_profile

[ -r "~/.bash_prompt" ] && source "~/.bash_prompt"

source ~/.shrc
