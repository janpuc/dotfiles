#!/bin/sh
# Ardia's agent skill in ~/.agents/skills/ardia, where Pi (and Codex) load skills, so Pi drives
# Jan's own Ardia with `ardia browse`. The cask installs only the app: the app installs the ardia
# command itself once Jan turns on Settings > Let the ardia command control Ardia (or opts in
# during onboarding). Until then this does nothing. After the first install, every CLI upgrade
# rewrites the skill (`ardia skills refresh`), so this only installs it once. --no-cua leaves out
# the computer-use driver's skill: browser only.
set -eu
ardia="$HOME/.local/bin/ardia"
[ -x "$ardia" ] || exit 0
[ -f "$HOME/.agents/skills/ardia/.ardia-skill" ] && exit 0
"$ardia" skills install --target general --no-cua
