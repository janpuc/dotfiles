<!-- kritika:pr-1668 -->
## <a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1668"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/rerun-dark.svg"><img alt="Re-run" src="https://kritika.janpuc.com/badges/rerun.svg" align="right"></picture></a><a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1668"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/view-dark.svg"><img alt="View" src="https://kritika.janpuc.com/badges/view.svg" align="right"></picture></a>Confidence Score: 3/5

**[Medium risk]** The reported P1 concerns the repo's automerge rule (.renovaterc.json5 has no matchCurrentVersion guard for 0.x minors), not the bumped line itself, which upstream evidence shows leaves this workflow's inputs and the resolved zizmor version unchanged; a maintainer should weigh whether that repo-wide policy note belongs on this PR, but it sets the ceiling as reported. Risk is medium because a 0.x minor bump of a CI action rates at least medium even though this step runs the same binary as before.

## Findings

**Outside the diff**

- <img alt="P1" src="https://kritika.janpuc.com/badges/p1.svg"> `.renovaterc.json5:18` 0.x minor of a GitHub Action automerges unattended despite the breaking `!` marker · reliability

  This is a 0.x minor update (v0.7.1 ➔ v0.8.0), and the repo's "Auto-merge GitHub Actions" rule in .renovaterc.json5 matches `matchManagers: ["github-actions"]` with `matchUpdateTypes: ["minor", "patch", "digest"]` and no `matchCurrentVersion` guard, so it automerges 0.x minors of actions. The shared preset that this repo extends, home-operations/renovate-presets 8.1.0 `default.json`, states this in terms for its own zer0ver rules: "No matchCurrentVersion guard is shipped for automerge: repo packageRules concatenate after presets, so add your own `matchCurrentVersion: \"!/^v?0/\"` if you automerge minors." This repository has no such guard anywhere (`grep matchCurrentVersion` over the repo's json5 returns nothing), so zizmor-action v0.8.0 lands unattended. This is not hypothetical for this dependency: v0.8.0 rewrote the action's version handling in `action.sh` (widening `version_regex` to accept `a`/`b`/`rc`/`.devN` suffixes and adding a `prerelease` alias) and v0.7.1's own `action.sh` shows the same class of change is made without notice in patch releases. The upstream release notes themselves say a 0.x minor "can break at any time". The `!` marker this PR's title carries is the preset's zer0ver convention for exactly this risk, and it is not backed by any automerge protection in this repo. Add a `matchCurrentVersion` guard so 0.x minors of GitHub Actions require a human.

### Summary

Bumps zizmor-action to v0.8.0, adding prerelease support upstream

The change moves the single `uses:` line in the `zizmor` job of .github/workflows/ci.yaml to zizmorcore/zizmor-action@53290badfa369cb0bf7ad16342cb62c2fa47ac7b (v0.8.0). Upstream v0.8.0 adds prerelease selection: action.sh gains a `prerelease` alias, `version_regex` widens to accept `a`/`b`/`rc` and `.devN` suffixes, and the `version` input description in action.yml is reworded. The inputs this workflow actually sets (`advanced-security: false`, `annotations: true`) are unchanged between the two tags, and because `version` is left unset the action still resolves `latest`, whose lock file is byte-identical in both tags (zizmor==1.31.1 with the same eleven hashes) — so the zizmor binary that runs is the same one as before. The one thing to note is outside the diff: this repository automerges minor GitHub Action updates with no `matchCurrentVersion` guard, so a 0.x minor such as this one merges unattended, which is what the shared preset's zer0ver rule warns about when it puts the `!` in the commit title.

<details>
<summary>Review context · 8 sources · 1/1 skills · 3/9 commands</summary>

- **Sources:**
  - <https://redirect.github.com/zizmorcore/zizmor-action/releases/tag/v0.8.0>
  - <https://redirect.github.com/zizmorcore/zizmor-action>
  - <https://redirect.github.com/zizmorcore/zizmor-action/pull/182>
  - <https://redirect.github.com/zizmorcore/zizmor-action/pull/184>
  - <https://redirect.github.com/janpuc/home-ops/pull/1668>
  - <https://redirect.github.com/zizmorcore/zizmor-action/compare/v0.7.1...v0.8.0>
  - <https://redirect.github.com/home-operations/renovate-presets/tree/8.1.0>
  - <https://redirect.github.com/zizmorcore/zizmor-action/tree/v0.7.1>
- **Skills read:** `renovate-review`
- **Commands run:** `find` `gh` `grep`

</details>

<sub>Reviews (1) · Last reviewed commit: ["feat(github-action)!: Update action zizm..."](https://github.com/janpuc/home-ops/commit/fab89b677fe0121bba32dd693309a00919fb4a14) · minimax/MiniMax-M3</sub>

