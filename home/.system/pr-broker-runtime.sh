#!/bin/sh
# Run by root only. Official, checksum-verified binaries, never pocket's mise installs.
# Pin exactly the versions in pi-pocket-mise.toml. Runtime never invokes mise/shims or
# evaluates its config: /opt/pr-broker and all ancestors/binaries remain root-owned.
set -eu
PATH=/usr/bin:/bin
export PATH
[ "$(id -u)" = 0 ] || { echo 'pr-broker-runtime: root required' >&2; exit 1; }
node_version=24.22.2
gh_version=2.102.0
# aether is aarch64 (verified with read-only ssh). Fail closed on other hosts.
case "$(uname -m)" in
    aarch64|arm64) node_arch=arm64; gh_arch=arm64 ;;
    *) echo 'pr-broker-runtime: unsupported architecture' >&2; exit 1 ;;
esac
# https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
node_sha256=95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2
# https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt
gh_sha256=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
install -d -o root -g root -m 755 /opt/pr-broker /opt/pr-broker/bin /opt/pr-broker/releases
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
cd "$tmp"
if [ ! -x "/opt/pr-broker/releases/node-$node_version/bin/node" ]; then
    archive="node-v$node_version-linux-$node_arch.tar.gz"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -O "https://nodejs.org/dist/v$node_version/$archive"
    printf '%s  %s\n' "$node_sha256" "$archive" > node-checksum
    sha256sum --check node-checksum
    tar -xzf "$archive"
    install -d -o root -g root -m 755 "/opt/pr-broker/releases/node-$node_version/bin"
    install -o root -g root -m 755 "node-v$node_version-linux-$node_arch/bin/node" "/opt/pr-broker/releases/node-$node_version/bin/node"
fi
if [ ! -x "/opt/pr-broker/releases/gh-$gh_version/bin/gh" ]; then
    archive="gh_${gh_version}_linux_$gh_arch.tar.gz"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -O "https://github.com/cli/cli/releases/download/v$gh_version/$archive"
    printf '%s  %s\n' "$gh_sha256" "$archive" > gh-checksum
    sha256sum --check gh-checksum
    tar -xzf "$archive"
    install -d -o root -g root -m 755 "/opt/pr-broker/releases/gh-$gh_version/bin"
    install -o root -g root -m 755 "gh_${gh_version}_linux_$gh_arch/bin/gh" "/opt/pr-broker/releases/gh-$gh_version/bin/gh"
fi
ln -sfn "/opt/pr-broker/releases/node-$node_version/bin/node" /opt/pr-broker/bin/node
ln -sfn "/opt/pr-broker/releases/gh-$gh_version/bin/gh" /opt/pr-broker/bin/gh
