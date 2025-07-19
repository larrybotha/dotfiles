source "$HOME"/.exports

# Use ~/.config/zsh as the default zsh config directory
export ZDOTDIR="$XDG_CONFIG_HOME/zsh"

# Allow for editing commands using the specified editor
export VISUAL="$EDITOR"

# Remove delay when switching from normal to insert mode
# when shell is in vi mode
export KEYTIMEOUT=1

# vim: set filetype=sh:
