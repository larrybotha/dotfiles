source ~/.shrc

# fzf must be sourced last before it's enable
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

if type direnv>/dev/null; then
  # enable direnv
  eval "$(direnv hook zsh)"
else
  echo "direnv not installed: $BASH_SOURCE"
fi

if type zoxide>/dev/null; then
  # enable zoxide
  eval "$(zoxide init zsh)"
else
  echo "zoxide not installed: $BASH_SOURCE"
fi

# tab complete on first tab, instead of from second tab
setopt MENU_COMPLETE
#  tab completion
#  1 - case insensitive
#  2 - match text anywhere in string
#                                      [1]                   [2]
zstyle ':completion:*' matcher-list '' 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=*' 'l:|=* r:|=*'


# Start tmux when zsh starts
#
# This starts tmux in a way that ensures that when tmux is exited, it won't kill
# the terminal that it was launched in
#
# This is useful when using services like tmuxinator that have scripts that run
# after a tmux session is killed. If the terminal emulator is not kept alive after
# detaching / killing a session, commands in options tmuxinator's on_project_exit
# won't be executed
if type tmux>/dev/null; then
 [[ ! $TERM =~ screen ]] && [ -z $TMUX ] && tmux
fi
