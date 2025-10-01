# Larry Botha's dotfiles

My personal dotfiles. Files are either copied or symlinked to their respective
`$HOME` directories from `./home`

## Installation

```sh
git clone https://github.com/larrybotha/dotfiles.git
cd dotfiles
./.install-deps
./.apply
./.macos
cp ~/.config/git/userconfig.example ~/.config/git/userconfig
vim ~/.config/git/userconfig
```

## Usage

```sh
# sync $HOME with ./home
./.apply

# update commonly used dependencies
just -g update
```

## Links and references

- [Mathias Bynens' dotfiles](https://github.com/mathiasbynens/dotfiles)
- [twpayne's dotfiles - creator of chezmoi](https://github.com/twpayne/dotfiles)
- [Inspirational dotfiles](https://dotfiles.github.io/inspiration/)

