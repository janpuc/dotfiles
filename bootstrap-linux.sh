#!/bin/sh
# Fresh Ubuntu server (aether): get mise, then let chezmoi lay down this repo.
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/janpuc/dotfiles/main/bootstrap-linux.sh)"
# After this `chezmoi apply` is the only command. See docs/aether.md for the manual steps.
set -eu

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates git

export PATH="$HOME/.local/bin:$PATH"
command -v mise >/dev/null || curl -fsSL https://mise.run | sh

# chezmoi comes from mise's own cache here; the applied mise config then manages it for good.
mise exec chezmoi@latest -- chezmoi init --apply janpuc/dotfiles
