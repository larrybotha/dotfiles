# allow for using homebrew completions
# must be set before calling compinit
# see https://github.com/casey/just#shell-completion-scripts
fpath=($HOMEBREW_PREFIX/share/zsh/site-functions $fpath)

source "$ZDOTDIR"/completions

source ~/.scripts/.aliases
source ~/.scripts/.functions
source ~/.scripts/.sh_prompt

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
