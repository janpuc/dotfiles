#!/usr/bin/env zsh

set -eufo pipefail

git -C "${CHEZMOI_WORKING_TREE}" remote set-url origin git@github.com:janpuc/dotfiles.git
