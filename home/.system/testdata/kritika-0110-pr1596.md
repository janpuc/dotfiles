<!-- kritika:pr-1596 -->
## <a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1596"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/rerun-dark.svg"><img alt="Re-run" src="https://kritika.janpuc.com/badges/rerun.svg" align="right"></picture></a><a href="https://kritika.janpuc.com/#/a/github/janpuc/pulls/janpuc/home-ops/1596"><picture><source media="(prefers-color-scheme: dark)" srcset="https://kritika.janpuc.com/badges/view-dark.svg"><img alt="View" src="https://kritika.janpuc.com/badges/view.svg" align="right"></picture></a>Confidence Score: 5/5

**[Medium risk]** The pin was verified against the registry digest, the image's env contract (ATUIN_CONFIG_DIR=/config, ATUIN_PORT=80) and the server's unchanged db migration set and /healthz path were read at v18.24.4, so the stateful sqlite-backed server keeps its schema and probes. Risk is medium: a five-release minor bump rolled out with Recreate strategy on a service whose data store a bad release could affect, though a revert undoes it.

### Summary

Bumps the pinned atuin server image to 18.24.4

Renovate moves the pinned atuin-server image from 18.23.0 to 18.24.4 in the selfhosted HelmRelease; merging it rolls the Deployment out through Flux, and the rendered app-template output shows strategy Recreate, so the single pod is stopped and started rather than swapped in place. The server-side delta since 18.24.3 is the new X-Forwarded-For client-address resolution (trusted_proxies and trusted_proxy_header, both empty by default) and the login handler taking the resolved ClientIp instead of ConnectInfo; the HelmRelease sets neither new setting, so requests keep being attributed to the TCP peer exactly as before, and the server still serves with into_make_service_with_connect_info, so the extractor finds the peer address it needs. The database schema is untouched between 18.23.0 and 18.24.4 and the /healthz probe path still answers 200, so no migration or probe change is needed; after the merge, the check worth making is that a client can still log in against the new pod, since the login handler's address extractor is the one path that changed.

<details>
<summary>Review context · 9 sources · 1/1 skills · 4/9 commands</summary>

- **Sources:**
  - <https://redirect.github.com/atuinsh/atuin/pull/4595>
  - <https://redirect.github.com/atuinsh/atuin/releases/tag/v18.24.4>
  - <https://redirect.github.com/atuinsh/atuin/pull/4572>
  - <https://redirect.github.com/atuinsh/atuin/compare/v18.24.3...v18.24.4>
  - <https://redirect.github.com/atuinsh/atuin/compare/v18.23.0...v18.24.4>
  - <https://redirect.github.com/atuinsh/atuin/tree/v18.23.0>
  - <https://redirect.github.com/atuinsh/atuin/tree/v18.24.4>
  - <oci://ghcr.io/atuinsh/atuin:18.24.4>
  - <oci://ghcr.io/atuinsh/atuin:18.23.0>
- **Skills read:** `renovate-review`
- **Commands run:** `find` `flate` `gh` `rg`

</details>

<sub>Reviews (5) · Last reviewed commit: ["feat(container): update image ghcr.io/at..."](https://github.com/janpuc/home-ops/commit/e4f1fdcea7fa092a22c2b168afa6122b7f576750) · minimax/MiniMax-M3</sub>

