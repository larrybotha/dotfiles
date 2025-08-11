# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is Larry Botha's personal dotfiles repository that manages configuration files for various development tools and applications on macOS. The repository uses a custom symlinking system to deploy configurations from the `./home` directory to the appropriate locations in `$HOME`.

## Key Commands

### Initial Setup
```bash
# Install dependencies (Homebrew, Go, Rust, Nix, Node.js via nvm)
./.install-deps

# Apply dotfiles (symlink configurations)
./.apply

# Apply dotfiles without confirmation prompt
./.apply -f
```

### Daily Usage
```bash
# Apply/sync dotfiles changes
./.apply

# Update commonly used dependencies
just -g update

# Update all dependencies
just -g update-all

# Update specific dependency file
just -g update-only <file>

# Start configured Aider with specific models
just -g start-aider
```

### Build Commands
```bash
# Apply dotfiles via Makefile
make apply
```

## Architecture

### Core Structure
- `./home/` - Source directory containing all dotfiles and configurations
- `./.apply` - Main deployment script that handles symlinking and copying
- `./.install-deps` - Dependency installation script for initial setup
- `Makefile` - Simple wrapper around `./.apply -f`

### Configuration Management
The `.apply` script manages two types of deployments:

1. **Symlinked Configurations**: Most configs are symlinked from `./home` to `$HOME`
   - Shell configs (`.zshenv`, `.bashrc`, etc.)
   - Application configs in `.config/` (nvim, git, tmux, etc.)
   - Scripts and utilities in `.scripts/`

2. **Replaced Configurations**: Some configs are copied rather than symlinked
   - `flameshot` and `htop` configurations

### Key Configuration Areas
- **Shell**: Zsh with custom configuration in `.config/zsh/`
- **Editor**: Neovim configuration in `.config/nvim/`
- **Terminal**: Multiple terminal emulators supported (kitty, ghostty)
- **Development Tools**: Git, tmux, lazygit, bat, and many others
- **System Tools**: Window managers (yabai, skhd), keyboard remapping (karabiner, kmonad)

### Dependency Management
- Uses `just` (justfile) for command runners with global justfile at `~/.config/just/justfile`
- Dependency update scripts located in `~/.scripts/deps/`
- Supports Homebrew, Neovim plugin updates, and nnn plugin updates

### Logging
The `.apply` script includes comprehensive logging to `./tmp/.dotfiles-apply.log` with timestamped entries and different log levels (INFO, WARN, ERROR).