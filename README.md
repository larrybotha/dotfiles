# Larry Botha's dotfiles

My personal dotfiles. Files are either copied or symlinked to their respective
`$HOME` directories from `./home`

## Installation

```sh
git clone https://github.com/larrybotha/dotfiles.git
cd dotfiles
./.install-deps
./.apply
./.osx
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
## TODO

- [ ] consider GPG and `pass` for managing secrets and env vars
    - https://github.com/olimorris/codecompanion.nvim/discussions/601
    - https://inconclusive.medium.com/sharing-passwords-with-git-gpg-and-pass-628c2db2a9de
    - https://blog.shr4pnel.com/gpg-quickstart
    - https://www.linuxbabe.com/security/a-practical-guide-to-gpg-part-1-generate-your-keypair

## Links and references

- [Mathias Bynens' dotfiles](https://github.com/mathiasbynens/dotfiles)
- [twpayne's dotfiles - creator of chezmoi](https://github.com/twpayne/dotfiles)
- [Inspirational dotfiles](https://dotfiles.github.io/inspiration/)







