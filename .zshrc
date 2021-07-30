source ~/.shrc
source ~/code/antigen/antigen.zsh

# Load the oh-my-zsh's library.
antigen use oh-my-zsh

antigen apply

# fzf must be sourced last before it's enable
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# enable direnv
eval "$(direnv hook zsh)"

# enable zoxide
eval "$(zoxide init zsh)"

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
