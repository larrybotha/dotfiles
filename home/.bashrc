#! /usr/bin/env bash

# .bashrc is sourced _every_ time a shell is started, or 'bash' is called

source ~/.scripts/.exports
source ~/.scripts/.aliases
source ~/.scripts/.functions
source ~/.scripts/.sh_prompt

# tmux only sources .bashrc, so we need to source .bash_profile manually
[[ -n "$PS1" && -z $TMUX ]] && source "$HOME"/.bash_profile

# use ctrl-p to open a file in vim
bind -x '"\C-p": vim $(fzf);'

# Case-insensitive globbing (used in pathname expansion)
shopt -s nocaseglob

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# Autocorrect typos in path names when using `cd`
shopt -s cdspell

# Enable some Bash 4 features when possible:
# * `autocd`, e.g. `**/qux` will enter `./foo/bar/baz/qux`
# * Recursive globbing, e.g. `echo **/*.txt`
for option in autocd globstar; do
  shopt -s "$option" 2>/dev/null
done
