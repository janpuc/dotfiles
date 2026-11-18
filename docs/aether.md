# aether (Ubuntu server): a dev machine reached through Rex

How to use the project agents day to day: [agents](agents.md).

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
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | through the read-only service account in `~/.config/op/aether.env`: log ubuntu's gh in from `op://Kubernetes/aether/GH_TOKEN` and write the same `~/.local/state/ai/credentials.fish` as the Macs (including the bridge's `claude setup-token`), plus 0600 per-project dotenv files, the restic password and the backup's Pushover credentials |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/dot_pi/private_agent/` and `home/dot_config/fish/functions/pi.fish` | common Pi packages, OS-aware instructions/settings, approval guard, project rotation, scoped Opus compaction and additive project trust |
| `home/.chezmoidata/projects.yaml` and `home/dot_config/agents/projects.json.tmpl` | project registry and runtime JSON on Linux and Mac |
| `home/dot_config/fish/functions/agent.fish` and `home/dot_local/bin/executable_agent-run` | Linux project cloning, Rex reconciliation and generation loop |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, project apt packages, Docker CE from the official resolute repo, system helpers, Rex and mise setup |
| `home/.system/rex-*` (installed by `07-linux-rex`) | Rex from its apt repository. The packaged login server plus a listener on the tailnet address port 7297, where tailscaled identifies each caller, lets `tailscale:janpuc@github` in as ubuntu. Clients use the bare name `aether.tail17d532.ts.net` |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |
| `home/.system/aether-backup*` (installed by `25-linux-backup`) | the hourly encrypted restic backup to BigMouth, its failure and staleness alerts, and the pinned host key placeholder `~/.config/aether-backup/known_hosts` |

The allowlist includes the project registry, `~/.local/bin/agent-run` and the backup's host key
placeholder, but no user-level systemd services or other AI runtimes. Project Pi sessions are
explicitly started with `agent up` after a reboot. The infrastructure units above are system
services, installed separately by the Linux scripts. Docker group membership requires a new login
and gives ubuntu root-equivalent access.
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
- `~/.ssh/aether-backup`: the key the hourly backup authenticates to BigMouth with, generated by
  `25-linux-backup`.
- `~/.config/restic/aether.password`, `~/.config/aether-backup/pushover.env` and
  `~/.config/aether-backup/known_hosts` (all 0600): the restic repository password, the Pushover
  credentials and the pinned NAS host key. ai-sync writes the first two, the operator fills in the
  third.

Run `fish -c ai-sync` manually after a key rotation. It also writes
`~/.local/state/ai/projects/<project>.env` (0600) from the registry's secret references.
Workspace mise.toml files load these with `_.file`. Plain environment such as HA_URL stays
in the workspace repo, never in the secret registry.

## Backup

`aether-backup.timer` runs hourly as the system user `ubuntu`, because everything in scope belongs
to `ubuntu`. systemd adds up to five minutes of jitter and a missed run starts at the next boot. It
is encrypted restic over restricted SFTP to BigMouth (`192.168.69.15`, reached over the tailnet),
and it is aether's only backup:

| Setting | Value |
|---|---|
| Repository | `sftp:aether-backup@192.168.69.15:/aether/restic`, the chrooted path inside the dataset `Vault/Backups/aether` |
| Included | `~/Development` with every workspace, `.git`, submodule stores, `.worktrees`, uncommitted and untracked files, `~/.pi/agent/sessions`, `~/.local/share/agent-history`, `~/.local/state/agents` and `~/.local/share/chezmoi` |
| Excluded | only `node_modules`, `.venv`, `__pycache__` and `.cache` directories, plus the runtime locks `.agent/run.lock` and `.agent/launch.lock`. No generic `*.lock` or `*.env` pattern |
| Not read | `~/.config/op`, `~/.config/gh` and `~/.local/state/ai` sit outside the included paths, so credential caches are never opened |
| Retention | `forget --keep-hourly 48 --keep-daily 30 --keep-weekly 12 --keep-monthly 12` every hour, `--prune` on the first run at or after 03:00, and `check --read-data-subset=1%` weekly |
| Status | `aether-backup status` prints the last successful run from `~/.local/state/aether-backup/last-success` |
| Alerts | Pushover for a failed unit through `aether-backup-alert@`, and from `aether-backup-watchdog.timer` when no run has succeeded for two hours, at most one message per six hours |

The backup is online: there is no checkpoint, quiescence or atomic snapshot, so a workspace
caught mid-write can restore inconsistently. The repository is created on the first run, and only
when restic reports it absent. Verify a restored copy before trusting it.

### NAS side

The NAS side is provisioned outside this repository by Jan or home-ops: a TrueNAS user
`aether-backup` with chrooted SFTP only, its home set to the dataset `Vault/Backups/aether`, a ZFS
snapshot policy for that dataset, and no shell or access to other datasets. On aether the operator
then has two things to do:

1. Add `~/.ssh/aether-backup.pub` to that user's authorized keys. `25-linux-backup` generates the
   key here and it is never committed. The installer prints the public half too.
2. Pin the NAS host key in `~/.config/aether-backup/known_hosts`. chezmoi creates that file once and
   never overwrites it. Read the fingerprint in the TrueNAS UI (System, SSH) first, and only then
   add the matching `ssh-keyscan -t ed25519 192.168.69.15` line. The backup fails with a clear
   error until an entry for the address exists.

Until both steps are done every run fails on purpose with an explicit error, and the watchdog
alerts after two hours.

The restic password and the alert credentials are not in this repository: `fish -c ai-sync` writes
`~/.config/restic/aether.password` from `op://Kubernetes/aether-backup/RESTIC_PASSWORD` and
`~/.config/aether-backup/pushover.env` (0600) from
`op://Kubernetes/alertmanager/ALERTMANAGER_PUSHOVER_TOKEN` and
`op://Kubernetes/pushover/PUSHOVER_USER_KEY`.

### Restore

On a fresh aether, in order:

1. Run `bootstrap-linux.sh` and `chezmoi apply`. That installs restic, the backup scripts, the units
   and the `known_hosts` placeholder.
2. Run `fish -c ai-sync` for the credentials and the restic password. Re-run it after a rotation.
3. If `~/.ssh/aether-backup` is new, add its public key to the NAS user as above. The repository
   does not care which key authenticates.
4. Pin the NAS host key as above, then check `aether-backup status` and
   `restic snapshots --latest 1` with the options below.
5. Restore into a staging directory, never over live paths, with
   `restic restore latest --target /tmp/aether-restore`, or add
   `--include /home/ubuntu/Development` to take one subtree. Only a clean machine should
   restore with `--target /`.
6. Verify each workspace with `git -C ~/Development/<project> fsck --full`, then its refs, committed
   gitlinks, dirty files and `.worktrees`. Check `~/.local/state/agents` and the Pi sessions you
   need before replacing anything live.
7. Start the agents with `agent up`, run one backup and confirm `aether-backup status` advances.

The restic options are the script's own, because `~/.ssh/config` is not managed on Linux:

```sh
restic -r sftp:aether-backup@192.168.69.15:/aether/restic \
    --password-file ~/.config/restic/aether.password \
    -o "sftp.command=ssh -i ~/.ssh/aether-backup -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.config/aether-backup/known_hosts -s sftp" \
    snapshots --latest 1
```

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
- the `pr-broker` system user and the old NFS `aether-backup` system user with `pr-requesters` and
  `nas-workspace` groups. The hourly backup runs as `ubuntu`, so aether needs no `aether-backup`
  user of its own. The NAS user of that name is separate and stays
- the units and their timers: `pi-pocket`, `pi-pocket-gh-token`, `pocket-watchdog`,
  `pocket-usage-report`, `pr-broker`, `pr-lane-merge`, `pr-approved-merge`,
  `mnt-bigmouth\x2dworkspace.mount` and `.automount` in `/etc/systemd/system`. The new backup reuses
  the `aether-backup.service` and `aether-backup.timer` names, so only its leftover root state below
  needs deleting
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
`systemctl status rex-login-server.service`, `systemctl --user list-unit-files`,
`systemctl status aether-backup.timer`, `aether-backup status`, `agent ls`, `rex ls --json`,
`docker version` and `docker compose version`. From the Mac target aether with `rex -S aether`.