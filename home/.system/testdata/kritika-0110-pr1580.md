<!-- kritika:pr-1580 -->
## <a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1580"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/rerun-dark.svg"><img alt="Re-run" src="https://kritika.janpuc.com/badges/rerun.svg" align="right"></picture></a><a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1580"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/view-dark.svg"><img alt="View" src="https://kritika.janpuc.com/badges/view.svg" align="right"></picture></a>Confidence Score: 4/5

**[Critical risk]** The account claims the 4.x-to-5.x database migration "was already taken when the earlier v5 tags landed," but the diff still moves from 4.0.20.3012, so merging runs the one-way v5 migration on the existing Sonarr database and a revert to the old tag will not read it; the account never checks for a pre-merge backup or restore path. That one-way schema migration, on an image that also sets SONARR__UPDATE__BRANCH=develop, is what puts the risk at critical: recovery from a failed v5 start would …

### Summary

Bumps Sonarr image to 5.0.0.2870 (major 4.x to 5.x)

The pull request pins ghcr.io/home-operations/sonarr to 5.0.0.2870 by digest in kubernetes/apps/media/sonarr/app/helmrelease.yaml:21, and the registry confirms that digest resolves to the 5.0.0.2870 tag for linux/arm64 and linux/amd64. Merging rolls the Sonarr Deployment out through Flux within the hour; the pod restarts with the new image, and any database migration the major 4.x-to-5.x bump introduced was already taken when the earlier v5 tags landed, not by this commit. The delta since the last review (v5.0.0.2838 to v5.0.0.2870) is 137 upstream files, nearly all frontend React work plus a new TMDb import-list type, a multi-season-pack release type, the v5 Queue API reshaped from SeasonNumbers to Seasons, and hardened log-cleansing regexes. None of that reaches this repository: the shell scripts under kubernetes/apps/media/sonarr/app/resources and the chaski webhook template use only /api/v3 endpoints, and no src/Sonarr.Api.V3 file appears in this range. The image's user, entrypoint and SONARR__UPDATE__BRANCH env are unchanged between the two tags, so the security context and probes in the HelmRelease still fit.

<details>
<summary>Review context · 6 sources · 1/1 skills · 3/9 commands</summary>

- **Sources:**
  - <https://redirect.github.com/Sonarr/Sonarr/releases/tag/v5.0.0.2870>
  - <https://redirect.github.com/Sonarr/Sonarr/releases/tag/v5.0.0.2838>
  - <https://redirect.github.com/Sonarr/Sonarr/compare/v5.0.0.2838...v5.0.0.2870>
  - <https://redirect.github.com/Sonarr/Sonarr/tree/v5.0.0.2870>
  - <oci://ghcr.io/home-operations/sonarr:5.0.0.2870>
  - <oci://ghcr.io/home-operations/sonarr:5.0.0.2838>
- **Skills read:** `renovate-review`
- **Commands run:** `find` `gh` `grep`

</details>

<sub>Reviews (10) · Last reviewed commit: ["feat(container)!: Update image ghcr.io/h..."](https://github.com/janpuc/home-ops/commit/016ed2fce640e716c4721fc1dfdcb2d076de5b90) · minimax/MiniMax-M3</sub>

