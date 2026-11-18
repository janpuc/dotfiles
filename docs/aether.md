# aether (Ubuntu server): a dev machine reached through Rex

Aether is Jan's Ubuntu server, and now only a development machine: the laptop reaches it through
Rex, and the Pi there can place subagents on it (`machine: "aether"`).
`chezmoi` gives it the same shell basics as the Macs, plus the internal DNS sync, the memory
hold and the Rex login server.
Laptop configuration stays on the Mac. An allowlist in `home/.chezmoiignore` makes that boundary
explicit: new laptop files do not reach Linux unless deliberately added there.

## What Linux manages

| Source | Purpose |
|---|---|
| `home/.chezmoidata/packages.yaml` → `linux.apt` | ca-certificates, curl, fish, git, jq (Pi's settings script), python3-yaml and zsh |
| `home/dot_config/mise/config.toml` | chezmoi, gh, 1Password CLI, starship, atuin, zoxide, eza, bat, difftastic, node and Pi |
| `home/dot_config/fish/config.fish.tmpl` and fish theme | fish with mise activation and the common shell tools, the AI endpoints, ai-sync's credential cache and the memini namespace hook, as on the Macs |
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | through the read-only service account in `~/.config/op/aether.env`: log ubuntu's gh in from `op://Kubernetes/aether/GH_TOKEN` and write the same `~/.local/state/ai/credentials.fish` as the Macs (including the bridge's `claude setup-token`) |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/dot_pi/private_agent/` and `home/dot_config/fish/functions/pi.fish` | ubuntu's Pi, the same as on hermes and sisyphus |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, system helpers, Rex and mise setup |
| `home/.system/rex-*` (installed by `07-linux-rex`) | Rex from its apt repository. The packaged login server plus a listener on the tailnet address port 7297, where tailscaled identifies each caller, lets `tailscale:janpuc@github` in as ubuntu. Clients use the bare name `aether.tail17d532.ts.net` |
| `home/.system/aether-hosts-sync*` (installed by `05-linux-system`) | hourly: derive internal DNS names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |

No user-level systemd services, AI dot-directories or `~/.local/bin` launchers are allowlisted.
The infrastructure units above are system services, installed separately by the Linux script.
`bootstrap-linux.sh` remains the initial mise/chezmoi bootstrap, not a retirement mechanism.

## What lives on the server only

Never in this public repository:

- `~/.config/op/aether.env` (0600): the read-only 1Password service-account token used by
  `ai-sync` to obtain the server's keys.
- `~/.config/gh/hosts.yml` (0600): gh's own stored authentication for the `ubuntu` user, used
  by Git's credential helper. It holds the aether token, which GitHub answers 401 to, so the
  `ubuntu` user's own gh is signed in with a dead token: a separate problem, not fixed here.
- `~/.ssh/id_ed25519`: the server's private SSH signing key. Git uses the corresponding
  `~/.ssh/id_ed25519.pub`, registered on GitHub as `aether-sign`.

Run `fish -c ai-sync` manually after a key rotation.

## Retirement and verification

Changing the allowlist does **not** delete previously deployed targets or uninstall tools.
The reviewed server cleanup must explicitly remove retired state before updating from the
pushed source. Do not remove the GitHub authentication, signing key, system helpers or shell
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
`systemctl status aether-hosts-sync.timer aether-keepalive.service`,
`systemctl status rex-login-server.service` and `systemctl --user list-unit-files`.