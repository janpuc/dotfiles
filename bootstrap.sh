#!/usr/bin/env zsh

# Usage: /bin/zsh -c "$(curl -fsSL https://bootstrap.janpuc.com)" -- <HOSTNAME>

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Error: Hostname argument is required."
    echo "Usage: $0 <HOSTNAME>"
    exit 1
fi

NEW_HOSTNAME="$1"
echo "Setting hostname to: $NEW_HOSTNAME"

echo "Configuring system names..."
sudo scutil --set HostName "$NEW_HOSTNAME"
sudo scutil --set LocalHostName "$NEW_HOSTNAME"
sudo scutil --set ComputerName "$NEW_HOSTNAME"

echo "Flushing DNS cache..."
dscacheutil -flushcache
echo "Hostname configuration complete."

echo "Checking for Xcode Command Line Tools..."
if xcode-select -p &>/dev/null; then
    echo "Xcode Command Line Tools are already installed."
else
    echo "Installing Xcode Command Line Tools (this may take a few minutes)..."
    xcode-select --install
    echo "Waiting for Xcode CLT installation to finish..."
    until xcode-select -p &>/dev/null; do
        sleep 5
    done
    echo "Xcode Command Line Tools installed successfully."
fi

echo "Running chezmoi init..."
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply janpuc
