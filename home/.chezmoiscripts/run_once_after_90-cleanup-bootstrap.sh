#!/usr/bin/env zsh

set -eufo pipefail

readonly CHEZMOI_BOOTSTRAP_DIR="~/bin"

if [ -d "$CHEZMOI_BOOTSTRAP_DIR" ]; then rm -Rf $CHEZMOI_BOOTSTRAP_DIR; fi
