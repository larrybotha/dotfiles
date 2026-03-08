# .zshenv - Environment setup for ALL zsh invocations
# This file runs for login, non-login, interactive, and non-interactive shells
# Keep this file FAST - no expensive operations!

# Initialize Homebrew FIRST
# This ensures HOMEBREW_PREFIX is available in all shell contexts
# Including tmux panes, embedded terminals, and subshells
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
elif [[ -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi

# Load fast static exports
source "$HOME/.scripts/.exports"

# ZDOTDIR must be set in ~/.zshenv (not in .exports)
# because once set, zsh looks for .zshenv in $ZDOTDIR for subsequent shells
export ZDOTDIR="$XDG_CONFIG_HOME/zsh"
# Allow for editing commands using the specified editor
export VISUAL="$EDITOR"
# Remove delay when switching from normal to insert mode
# when shell is in vi mode
export KEYTIMEOUT=1

# vim: set filetype=sh:
