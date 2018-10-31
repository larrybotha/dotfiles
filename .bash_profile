# Add homebrew's installs to the `$PATH` before non-Homebrew things
export PATH="/usr/local/bin:$PATH"
# Add `~/bin` to the `$PATH`
export PATH="$HOME/bin:$PATH"
# Add `~/.local/bin` to the `$PATH` for Haskell Tool Stack
export PATH="$HOME/.local/bin:$PATH"
# Add Google's depot_tools for adding Chrome to iOS Simulator to path
# Installation: https://chromium.googlesource.com/chromium/src/+/master/docs/ios/build_instructions.md
# Install to ~/code/depot_tools
export PATH="$PATH:~/code/depot_tools"

# Add Node and NVM to `$PATH`
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion


# add npm script completion
if type "npm" > /dev/null; then
  npm completion >> ~/.bash_profile
fi


# make Vim the editor for tmux
export EDITOR="vim"

# go lang
export GOPATH=$HOME/golang
export GOROOT=/usr/local/opt/go/libexec
export PATH=$PATH:$GOPATH/bin
export PATH=$PATH:$GOROOT/bin

# Load the shell dotfiles, and then some:
# * ~/.path can be used to extend `$PATH`.
# * ~/.extra can be used for other settings you don’t want to commit.
for file in ~/.{path,bash_prompt,exports,aliases,functions,extra}; do
	[ -r "$file" ] && source "$file"
done
unset file

# init z   https://github.com/rupa/z
if [ -f ~/code/z/z.sh ]; then
	. ~/code/z/z.sh
fi

# init git-completion https://github.com/git/git/blob/master/contrib/completion/git-completion.bash
if [ -f ~/code/git-completion/git-completion.bash ]; then
	. ~/code/git-completion/git-completion.bash
fi

#add git aliases to git-completion
complete -o default -o nospace -F _git g
complete -o default -o nospace -F _git_checkout co

# init rbenv
eval "$(rbenv init -)"

# activate tmux autocomplete
source ~/.tmux/tmux_completion.sh

# activate autoenv
source /usr/local/opt/autoenv/activate.sh

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
	shopt -s "$option" 2> /dev/null
done

# Add tab completion for SSH hostnames based on ~/.ssh/config, ignoring wildcards
[ -e "$HOME/.ssh/config" ] && complete -o "default" -o "nospace" -W "$(grep "^Host" ~/.ssh/config | grep -v "[?*]" | cut -d " " -f2 | tr ' ' '\n')" scp sftp ssh

# Add tab completion for `defaults read|write NSGlobalDomain`
# You could just use `-g` instead, but I like being explicit
complete -W "NSGlobalDomain" defaults

# Add `killall` tab completion for common apps
complete -o "nospace" -W "Contacts Calendar Dock Finder Mail Safari iTunes SystemUIServer Terminal Twitter" killall

# Enable php-version
source $(brew --prefix php-version)/php-version.sh && php-version 5

# If possible, add tab completion for many more commands
[ -f /etc/bash_completion ] && source /etc/bash_completion
