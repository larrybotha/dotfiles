# Homebrew completions
# HOMEBREW_PREFIX is guaranteed to be set by .zshenv
# It's available in all shell contexts (login, non-login, tmux, etc.)
fpath=($HOMEBREW_PREFIX/share/zsh/site-functions $fpath)

source "$ZDOTDIR"/completions

source ~/.scripts/.aliases
source ~/.scripts/.functions

# Load NVM lazily (only when node/npm/nvm/npx is called)
# This is sourced BEFORE .common_shrc to prevent duplicate loading
source ~/.scripts/.nvm-lazy

source "$HOME/.scripts/.common_shrc"

cursor_mode() {
    # See https://ttssh2.osdn.jp/manual/4/en/usage/tips/vim.html for cursor shapes
    cursor_block='\e[2 q'
    cursor_beam='\e[6 q'

    function zle-keymap-select {
        if [[ ${KEYMAP} == vicmd ]] ||
            [[ $1 = 'block' ]]; then
            echo -ne $cursor_block
        elif [[ ${KEYMAP} == main ]] ||
            [[ ${KEYMAP} == viins ]] ||
            [[ ${KEYMAP} = '' ]] ||
            [[ $1 = 'beam' ]]; then
            echo -ne $cursor_beam
        fi
    }

    zle-line-init() {
        echo -ne $cursor_beam
    }

    zle -N zle-keymap-select
    zle -N zle-line-init
}

cursor_mode

# vim: set filetype=zsh:
