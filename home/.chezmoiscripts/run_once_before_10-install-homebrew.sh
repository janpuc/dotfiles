#!/usr/bin/env bash

set -euo pipefail

# This script installs Homebrew if it is not yet installed on the system.

# Check for Homebrew
if ! command -v brew &> /dev/null; then
    printf "Info: Homebrew is not installed. Installing Homebrew...\n"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    printf "Info: Homebrew is already installed. Continuing...\n"
fi

# Show Homebrew version
BREW_VERSION="$(${BREW_PATH} --version)"
printf "Info: Found %s installed.\n" "${BREW_VERSION}"
