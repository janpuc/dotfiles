<!-- kritika:pr-1595 -->
## <a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1595"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/rerun-dark.svg"><img alt="Re-run" src="https://kritika.janpuc.com/badges/rerun.svg" align="right"></picture></a><a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1595"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/view-dark.svg"><img alt="View" src="https://kritika.janpuc.com/badges/view.svg" align="right"></picture></a>Confidence Score: 5/5

**[Medium risk]** Risk rests on a patch-level bump of a central dependency: the tuppr TalosUpgrade version means merging drains, upgrades and power-cycles each control-plane node to a new kernel and etcd 3.7.3, so a bad outcome is undone by downgrading nodes rather than reverting the manifest, while the mise/factory pins only affect tooling and reinstalls.

### Summary

Bumps the Talos group from v1.14.2 to v1.14.5 across CI, mise and tuppr

The PR moves four Talos pins together from v1.14.2 to v1.14.5: the CI workflow's TALOS_VERSION used by `mise exec "talosctl@${TALOS_VERSION}"` for the image-pull job, the mise talos tool pin with regenerated aqua checksums in .mise/mise.lock, the tuppr TalosUpgrade version that drives the in-cluster node upgrades, and the Image Factory installer tag in talos/cluster.yaml.j2. Merging rolls out the tuppr upgrade: each control-plane node is drained, upgraded and power-cycled to v1.14.5, while the factory tag only affects machines reinstalled or upgraded by `just talos upgrade-node`. The CI job resolves talosctl v1.14.5 through the aqua backend, so the first pull on a runner fetches that release. Upstream v1.14.3 through v1.14.5 bring the PTP/NTS time-config validation, the etcd 3.7.3 bump, the Linux 6.18.58 kernel and the on-demand kernel module helper; nothing in this repository's machine configuration sets a time server or a PTP device, and the only etcd metrics override stays on listen-metrics-urls http://0.0.0.0:2381. After merging, expect the three control-plane nodes to reboot one at a time under the tuppr policy; a check worth making afterwards is that etcd stays quorum on 2379 and that the miroir/DRBD volumes re-import cleanly on the new kernel.

<details>
<summary>Review context · 16 sources · 1/1 skills · 4/9 commands</summary>

- **Sources:**
  - <https://redirect.github.com/siderolabs/talos/releases/tag/v1.14.3>
  - <https://redirect.github.com/siderolabs/talos/releases/tag/v1.14.4>
  - <https://redirect.github.com/janpuc/home-ops/pull/1595>
  - <https://redirect.github.com/janpuc/home-ops>
  - <https://redirect.github.com/siderolabs/talos/releases/tag/v1.14.5>
  - <https://redirect.github.com/janpuc/home-ops/blob/main/.github/workflows/ci.yaml>
  - <https://redirect.github.com/janpuc/home-ops/commit/bab75494148a2e0dfb65c02cb8250df3c75baa91>
  - <https://redirect.github.com/janpuc/home-ops/commit/9b05f7b3a1c15ba73c3b37cfc69e7e09ee9308f6>
  - <https://redirect.github.com/siderolabs/pkgs/commit/2ec10eb>
  - <https://redirect.github.com/janpuc/home-ops/compare/692c0bd...bab75494148a2e0dfb65c02cb8250df3c75baa91>
  - <https://redirect.github.com/siderolabs/talos/compare/v1.14.2...v1.14.5>
  - <https://redirect.github.com/siderolabs/pkgs/blob/f4bda77/drbd/cocci-cache/amd64>
  - <https://redirect.github.com/siderolabs/pkgs/commit/f4bda77>
  - <https://factory.talos.dev/schematics>
  - <https://redirect.github.com/siderolabs/talos/compare/v1.14.2...v1.14.3>
  - <https://redirect.github.com/siderolabs/talos/tree/v1.14.5>
- **Skills read:** `renovate-review`
- **Commands run:** `curl` `fd` `gh` `rg`

</details>

_The review's agent was told to submit what it had found as its time ran out, so it may not cover all it meant to check._

<sub>Reviews (4) · Last reviewed commit: ["fix(container): update talos group"](https://github.com/janpuc/home-ops/commit/bab75494148a2e0dfb65c02cb8250df3c75baa91) · minimax/MiniMax-M3</sub>

