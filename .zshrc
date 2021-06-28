source ~/.shrc
source ~/code/antigen/antigen.zsh

# Load the oh-my-zsh's library.
antigen use oh-my-zsh

antigen apply

# fzf must be sourced last before it's enable
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# enable direnv
eval "$(direnv hook zsh)"
