#!/usr/bin/env zsh

set -eufo pipefail

# Pull over HTTPS (the repository is public), so a headless machine never waits on the 1Password
# SSH agent's approval; push over SSH.
git -C "${CHEZMOI_WORKING_TREE}" remote set-url origin https://github.com/janpuc/dotfiles.git
git -C "${CHEZMOI_WORKING_TREE}" remote set-url --push origin git@github.com:janpuc/dotfiles.git
