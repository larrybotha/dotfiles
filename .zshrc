source ~/.shrc
source ~/.zsh_completion

# fzf must be sourced last before it's enabled
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# replace fzf's ctrl-R with atuin's search
bindkey '^r' _atuin_search_widget

if type zoxide>/dev/null; then
  # enable zoxide
  eval "$(zoxide init zsh)"
else
  echo "zoxide not installed: $BASH_SOURCE"
fi

# Start tmux when zsh starts
#
# This starts tmux in a way that ensures that when tmux is exited, it won't kill
# the terminal that it was launched in
#
# This is useful when using services like tmuxinator that have scripts that run
# after a tmux session is killed. If the terminal emulator is not kept alive after
# detaching / killing a session, commands in options tmuxinator's on_project_exit
# won't be executed
if type tmux >/dev/null; then
 [[ ! $TERM =~ screen ]] && [ -z ${TMUX+x} ] && tmux
 #        [1]                   [2]          [3]
 # 1 - ensure we're not running in a GNU Screen terminal multiplexer
 # 2 - ensure the $TMUX env var is empty - i.e. no current tmux session
 # 3 - start a tmux session
fi

if type starship >/dev/null; then
  eval "$(starship init zsh)"
fi
