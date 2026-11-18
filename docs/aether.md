# aether (Ubuntu server): a dev machine reached through Rex

aether is Jan's Oracle ARM VM running Ubuntu 26.04.1 as `ubuntu`, reached from the Mac app
through its Rex login server. It hosts one long-lived Pi per project under
`~/Development/<project>`. Project agents do their own work and use local Rex tabs for
bounded child jobs, with no remote subagent machines. The Mac can still place children on
aether. See [Projects on aether](projects.md) for the registry, tools, approvals and rotation.
`chezmoi` gives it common shell basics, project launchers, the memory hold and Rex. Home names resolve through Tailscale split DNS (see [Home network](#home-network)).
Laptop configuration stays on the Mac. An allowlist in `home/.chezmoiignore` makes that boundary
explicit: new laptop files do not reach Linux unless deliberately added there.

## What Linux manages

| Source | Purpose |
|---|---|
| `home/.chezmoidata/packages.yaml` → `linux.apt` | ca-certificates, curl, fish, git, jq (Pi's settings script), python3-yaml and zsh |
| `home/dot_config/mise/config.toml` | chezmoi, gh, 1Password CLI, shell tools, yq, ripgrep, uv, node and Pi, with trusted configs under ~/Development |
| `home/dot_config/fish/config.fish.tmpl` and fish theme | fish with mise activation and the common shell tools, the AI endpoints, ai-sync's credential cache and the memini namespace hook, as on the Macs |
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | through the read-only service account in `~/.config/op/aether.env`: log ubuntu's gh in from `op://Kubernetes/aether/GH_TOKEN` and write the same `~/.local/state/ai/credentials.fish` as the Macs (including the bridge's `claude setup-token`), plus 0600 per-project dotenv files |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/dot_pi/private_agent/` and `home/dot_config/fish/functions/pi.fish` | common Pi packages, OS-aware instructions/settings, approval guard, project rotation, scoped Opus compaction and additive project trust |
| `home/.chezmoidata/projects.yaml` and `home/dot_config/agents/projects.json.tmpl` | project registry and runtime JSON on Linux and Mac |
| `home/dot_config/fish/functions/agent.fish` and `home/dot_local/bin/executable_agent-run` | Linux project cloning, Rex reconciliation and generation loop |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, project apt packages, Docker CE from the official resolute repo, system helpers, Rex and mise setup |
| `home/.system/rex-*` (installed by `07-linux-rex`) | Rex from its apt repository. The packaged login server plus a listener on the tailnet address port 7297, where tailscaled identifies each caller, lets `tailscale:janpuc@github` in as ubuntu. Clients use the bare name `aether.tail17d532.ts.net` |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |

The allowlist includes the project registry and `~/.local/bin/agent-run`, but no user-level
systemd services or other AI runtimes. Project Pi sessions are explicitly started with
`agent up` after a reboot. The infrastructure units above are system services, installed
separately by the Linux scripts. Docker group membership requires a new login and gives
ubuntu root-equivalent access.
`bootstrap-linux.sh` remains the initial mise/chezmoi bootstrap, not a retirement mechanism.

## Home network

Aether reaches the home LAN through the tailnet: the Apple TV (`apple-tv`) advertises
192.168.69.0/24 and 192.168.70.0/24, and aether runs with `--accept-routes`. Home names come
from the UniFi gateway through Tailscale split DNS (admin console, DNS: nameserver 192.168.69.1
restricted to `janpuc.com`, `internal`, `69.168.192.in-addr.arpa` and `70.168.192.in-addr.arpa`), and
aether runs with `--accept-dns`. That covers the external-dns records for the cluster
(`k8s.janpuc.com`, which the kubeconfig uses, and every app on envoy-internal and
envoy-external), the DHCP and reservation names under `internal` and reverse lookups.
Nothing on aether keeps its own copy: the old hourly `/etc/hosts` sync from home-ops was
retired when the gateway started answering DNS from the tailnet (the `05-linux-system` script
removes it and its block in `/etc/hosts`).

## What lives on the server only

Never in this public repository:

- `~/.config/op/aether.env` (0600): the read-only 1Password service-account token used by
  `ai-sync` to obtain the server's keys.
- `~/.config/gh/hosts.yml` (0600): gh's own stored authentication for the `ubuntu` user, used
  by Git's credential helper. It holds the aether token, which GitHub answers 401 to, so the
  `ubuntu` user's own gh is signed in with a dead token: a separate problem, not fixed here.
- `~/.ssh/id_ed25519`: the server's private SSH signing key. Git uses the corresponding
  `~/.ssh/id_ed25519.pub`, registered on GitHub as `aether-sign`.

Run `fish -c ai-sync` manually after a key rotation. It also writes
`~/.local/state/ai/projects/<project>.env` (0600) from the registry's secret references.
Workspace mise.toml files load these with `_.file`. Plain environment such as HA_URL stays
in the workspace repo, never in the secret registry.

## Retirement and verification

Changing the allowlist does **not** delete previously deployed targets or uninstall tools.
The Linux `.chezmoiremove` explicitly removes the retired Pi local files `pocket.ts`,
`pocket.test.ts` and `pocket-api.md`. Other retired state needs reviewed operator cleanup
before updating from the pushed source. Do not remove the GitHub authentication, signing key, system helpers or shell
basics above.

Retiring Pi Pocket left state on aether that only the operator can remove, since nothing in
this repository installs it any more:

- the `pocket` user and its home, `/home/pocket` (Pi Pocket's database and archives, Pi's
  settings and models, the read-only kubeconfig, the sign-in keys)
- the `pr-broker` and `aether-backup` system users with `pr-requesters` and `nas-workspace`
  groups
- the units and their timers: `pi-pocket`, `pi-pocket-gh-token`, `pocket-watchdog`,
  `pocket-usage-report`, `pr-broker`, `pr-lane-merge`, `pr-approved-merge`, `aether-backup`,
  `mnt-bigmouth\x2dworkspace.mount` and `.automount` in `/etc/systemd/system`
- the root-owned configuration and state: `/etc/pr-broker`, `/etc/pocket-watchdog`,
  `/etc/pocket-usage-report`, `/var/lib/pr-broker`, `/var/lib/pocket-watchdog`,
  `/var/lib/pocket-usage-report`, `/var/lib/aether-backup`, `/var/spool/pr-broker` and
  `/opt/pr-broker`
- the scripts in `/usr/local/sbin`: `pi-pocket-gh-token`, `pocket-watchdog`,
  `pocket-usage-report`, `agent-push`, `pr-lane`, `pr-broker`, `pr-merge-request`,
  `pr-lane-merge`, `pr-approved-merge`, `pr-broker-lock`, `upstream-diff`, `trainer-media`,
  `aether-backup` and `aether-backup-stage`
- `/mnt/bigmouth-workspace` once it is unmounted, and `nfs-common` if nothing else needs it
- the tailnet HTTPS listener that served Pi Pocket: `sudo tailscale serve --https=443 off`.

Outside the server and this repository, revoke the `janpuc-agent` and `janpuc-merger` GitHub
Apps and their 1Password items in `op://Kubernetes`, and delete the `pi-pocket` service account
and Role from home-ops.

Read-only checks include `chezmoi managed`, `mise ls`, `gh auth status`,
`systemctl status aether-keepalive.service`, `resolvectl query k8s.janpuc.com`,
`systemctl status rex-login-server.service`, `systemctl --user list-unit-files`, `agent ls`,
`rex ls --json`, `docker version` and `docker compose version`. From the Mac target aether
with `rex -S aether`. BigMouth project backup comes in a later change.