#!/bin/sh
# Rex for Mac, which has no Homebrew cask: the newest DMG from the app's own update feed, once.
# Sparkle keeps it updated after that. Afterwards, by hand: give Rex Server.app Full Disk Access
# (System Settings > Privacy & Security), or op cannot reach 1Password from Rex panes.
set -eu
app="/Applications/Rex Beta.app"
[ -d "$app" ] && exit 0
feed=https://blob.superlogical.com/public/rex-app/preview/appcast.xml
url=$(curl -fsSL "$feed" | grep -o 'url="[^"]*\.dmg"' | head -1 | cut -d'"' -f2)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/rex.dmg" "$url"
mnt="$tmp/mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/rex.dmg"
ditto "$mnt/Rex Beta.app" "$app"
hdiutil detach -quiet "$mnt"
codesign --verify --deep --strict "$app"
echo "Installed $app from $url"
