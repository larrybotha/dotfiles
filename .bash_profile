# Add homebrew's installs to the `$PATH` before non-Homebrew things
export PATH="/usr/local/bin:$PATH"
# Add `~/bin` to the `$PATH`
export PATH="$HOME/bin:$PATH"

# Add Node to `$PATH`
export PATH="$HOME/.node/bin:$PATH"

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

# Autocomplete Grunt commands
which grunt &> /dev/null && eval "$(grunt --completion=bash)"

# Enable php-version
source $(brew --prefix php-version)/php-version.sh && php-version 5

# If possible, add tab completion for many more commands
[ -f /etc/bash_completion ] && source /etc/bash_completion

# Run nvm.sh if nvm is installed
[ -f $(brew --prefix nvm)/nvm.sh ] && source $(brew --prefix nvm)/nvm.sh
