#!/usr/bin/env zsh

set -eufo pipefail

marketplace_found=false
for registry in "$HOME/.omp/marketplaces.json" "${XDG_DATA_HOME:-$HOME/.local/share}/omp/marketplaces.json"; do
    if [[ -f "$registry" ]] && /opt/homebrew/bin/jq -e '.marketplaces[] | select(.name == "memini")' "$registry" >/dev/null; then
        marketplace_found=true
        break
    fi
done

if [[ "$marketplace_found" != true ]]; then
    /opt/homebrew/bin/omp plugin marketplace add eleboucher/memini
fi

if ! /opt/homebrew/bin/omp plugin list --json | /opt/homebrew/bin/jq -e '.marketplace[] | select(.id == "memini@memini")' >/dev/null; then
    /opt/homebrew/bin/omp plugin install memini@memini
fi

/opt/homebrew/bin/omp plugin install @eleboucher/pi-memini
