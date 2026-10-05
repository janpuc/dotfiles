#!/usr/bin/env zsh

set -eufo pipefail

# Marketplace and plugin state is profile-scoped: a named profile keeps its own
# marketplaces.json and plugins/installed_plugins.json under
# ~/.omp/profiles/<name>, so a fresh profile starts with zero plugins. memini
# therefore has to be installed once per profile, not once per machine. "" is
# the default profile (personal subs); "work" carries the enterprise Claude seat.
configure_omp_profile() {
    local profile="$1"
    local -a omp roots
    local base root

    omp=(/opt/homebrew/bin/omp)
    [[ -n "$profile" ]] && omp+=(--profile "$profile")

    for base in "$HOME/.omp" "${XDG_DATA_HOME:-$HOME/.local/share}/omp"; do
        if [[ -n "$profile" ]]; then
            roots+=("$base/profiles/$profile")
        else
            roots+=("$base")
        fi
    done

    local marketplace_found=false
    for root in "${roots[@]}"; do
        if [[ -f "$root/marketplaces.json" ]] && /opt/homebrew/bin/jq -e '.marketplaces[] | select(.name == "memini")' "$root/marketplaces.json" >/dev/null; then
            marketplace_found=true
            break
        fi
    done

    if [[ "$marketplace_found" != true ]]; then
        "${omp[@]}" plugin marketplace add eleboucher/memini
    fi

    if ! "${omp[@]}" plugin list --json | /opt/homebrew/bin/jq -e '.marketplace[] | select(.id == "memini@memini")' >/dev/null; then
        "${omp[@]}" plugin install memini@memini
    fi

    "${omp[@]}" plugin install @eleboucher/pi-memini
}

configure_omp_profile ""
configure_omp_profile work
