# aether (Ubuntu server): shell basics and infrastructure helpers

Aether keeps a familiar remote shell, two infrastructure helpers (internal DNS sync and
keepalive) and Pi Pocket, Jan's assistant. Laptop configuration stays on the Mac.
An allowlist in `home/.chezmoiignore` makes that boundary explicit: new laptop files do not
reach Linux unless deliberately added there.

## What Linux manages

| Source | Purpose |
|---|---|
| `home/.chezmoidata/packages.yaml` → `linux.apt` | ca-certificates, curl, fish, git, python3-yaml and zsh |
| `home/dot_config/mise/config.toml` | chezmoi, gh, 1Password CLI, starship, atuin, zoxide, eza, bat and difftastic |
| `home/dot_config/fish/config.fish.tmpl` and fish theme | fish with mise activation and the common shell tools; no AI credential cache or memory hook on Linux |
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | Linux: give Pi Pocket and pr-broker their keys from 1Password; leave ubuntu's gh login untouched |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, system helpers, terminfo and mise setup |
| `home/.system/aether-hosts-sync*` (installed by `05-linux-system`) | hourly: derive internal DNS names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/xterm-ghostty.terminfo` (`06-linux-terminfo`) | Ghostty terminfo in `~/.terminfo`, absent from Ubuntu's ncurses |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |
| `home/.system/aether-backup*`, `mnt-bigmouth\\x2dworkspace.{mount,automount}` (installed by `25-linux-aether-backup`) | online state backup to BigMouth daily at 03:30, 14 calendar days retained |
| `home/.system/pi-pocket*` (installed by `20-linux-pi-pocket`) | [Pi Pocket](https://github.com/TannerMidd/pi-pocket) at pinned **v0.27.0-beta.7** (`78f547579cc5433a28cdb765524597f5bb07c329`), run by the `pocket` user (no sudo, sees only its own home) as the `pi-pocket` system service on 127.0.0.1:8787; `tailscale serve` publishes it at `https://aether.<tailnet>.ts.net` on the tailnet only. At home the same URL works without Tailscale: a UniFi DNS record (`aether.tail17d532.ts.net` → aether's tailnet address, 100.108.252.49) and bob, the router on the tailnet, carry it. Node comes from pocket's own mise config. `pi-pocket-extensions/memini.ts` gives it memory in memini namespace `homelab/assistant` (home `personal/jan`): a briefing per conversation, recall on each message, and `memory_recall`/`memory_remember` tools; test it with `node --test` on its `memini.test.ts`. `approvals.ts` asks Jan in the app (push notification) before a bash command changes a shared system: git push, GitHub writes, cluster, Flux, Talos or Helm changes, chezmoi apply, Home Assistant service calls (except the lights, scenes and reload services below, which are direct). `web.ts` gives it `web_search` (the home SearXNG at search.janpuc.com) and `web_fetch` (pages as text, with a FlareSolverr fallback). `pi-pocket-skills/` holds Pi skills for the cluster (read-only `view` access, Alertmanager and Prometheus over HTTPS), Home Assistant (`$HA_URL`, `$HA_TOKEN`, and Jan's Home Assistant configuration in `janpuc/home-assistant`) and GitHub (`gh`, signed in with the App's installation token). `ask-jan.ts` asks Jan a question on a card in the session, with the same push as an approval, with tappable answers and an Other field, and passes back his choice or his own words verbatim as owner instructions. pocket's mise config adds gh, kubectl, flux and jq. `pi-pocket-gh-token` (a systemd timer, as `pocket`, every half hour) mints an installation token of the agent's own GitHub App, janpuc-agent (only home-ops, dotfiles, BC250 and home-assistant, with a fallback to the older three until Jan adds the new repository to the installation; no admin or workflow rights; key from op://Kubernetes/janpuc-agent), and writes it into gh's own config for `pocket`, because a running service cannot see new environment values; git over HTTPS reads it through the `mise exec -- gh auth git-credential` helper. For dev work pocket commits as `janpuc-agent[bot]` (never as `bot-atlas[bot]`, the Renovate and kritika App, or Renovate takes the branch for its own), signed locally with its own key (`~pocket/.ssh/signing`, on GitHub as "pi-pocket (aether)"), but publishes only through `agent-push` for GitHub-verified App commits (see the PR shepherd below); home-ops, dotfiles, BC250 and home-assistant are cloned into `~pocket/work/` (the last one skipped, without failing, while the repository or the App installation does not have it yet) and trusted by mise, and new sessions start in `~pocket/scratch` |

No user-level systemd services, AI dot-directories or `~/.local/bin` launchers are allowlisted.
The infrastructure units above are system services, installed separately by the Linux script.
`bootstrap-linux.sh` remains the initial mise/chezmoi bootstrap, not a retirement mechanism.

## What lives on the server only

Never in this public repository:

- `~/.config/op/aether.env` (0600): the read-only 1Password service-account token used by
  `ai-sync` to obtain the server's keys. It is still needed for this GitHub-only workflow.
- `~/.config/gh/hosts.yml` (0600): gh's own stored authentication for the `ubuntu` user, used
  by Git's credential helper. It holds the aether token, which GitHub now answers 401 to, so
  the `ubuntu` user's own gh is signed in with a dead token: a separate problem, not fixed here.
- `~/.ssh/id_ed25519`: the server's private SSH signing key. Git uses the corresponding
  `~/.ssh/id_ed25519.pub`, registered on GitHub as `aether-sign`.
- `/home/pocket/.config/pi-pocket/secrets.env` (0600, owned by pocket): Pi Pocket's model
  keys (OpenCode Go, MiniMax, and the Claude API key with its monthly plan credit) and its
  memini key, written
  by `ai-sync` from 1Password and loaded into the service by pocket's mise
  config. Run `fish -c ai-sync` again after a key rotation; it restarts the service.
- `/home/pocket/.config/pi-pocket/github-app.pem` (0600, owned by pocket) and
  `github-app-client-id`: the agent's GitHub App ("janpuc-agent") key and client id, written by `ai-sync`
  from 1Password. The token helper signs a JWT with the key and mints installation tokens
  from it; neither the key nor a token is ever in pocket's environment.
- `/home/pocket/.config/gh/hosts.yml` (0600, owned by pocket): gh's own stored authentication
  for the `pocket` user, holding the installation token the helper mints.
- `/home/pocket/.kube/config` (0600): a kubeconfig for the `pi-pocket` service account in
  home-ops (`kubernetes/apps/ai/pi-pocket`, the view role). Install or refresh it from the Mac
  with `pocket-kube-sync`, which reads the account's token with the home-ops admin kubeconfig.
- `/home/pocket/.pi-pocket/`: Pi Pocket's database, push keys and sign-ins. Print the owner
  sign-in link from the Mac with
  `aether sudo cat /home/pocket/.pi-pocket/config.json | jq -r '"https://aether.tail17d532.ts.net/login?token=" + (.ownerToken|@uri)'`.
- `/home/pocket/archive/pi-pocket-<version>-<date>.tar.gz`: the data folder as it was before
  an upgrade. Pi Durable 1.4 rewrites `pocket.sqlite` the first time it opens it, and older
  servers cannot read it again, so this archive is the way back.

Run `fish -c ai-sync` manually to refresh the Apps' credentials and Pi Pocket's model keys.
It no longer reads `op://Kubernetes/aether/GH_TOKEN` or attempts `gh auth login` for ubuntu.
Read-only inspection during backup preparation confirmed ubuntu's `gh auth status` still
reports an invalid stored token for **janpuc** in `/home/ubuntu/.config/gh/hosts.yml`, and Git
still uses `gh auth git-credential`. This change neither replaces nor removes that login.
Linux no longer fetches or sources `~/.local/state/ai/credentials.fish`.

## State backup to BigMouth

`25-linux-aether-backup` installs `nfs-common` if needed, the `nas-workspace` group at
**gid 3100**, a dedicated system user `aether-backup` (primary group `nas-workspace`,
no login, no home, no supplementary groups), two system scripts and systemd units.
The timer runs daily at **03:30 aether local time**, with `Persistent=true` to catch up
missed runs. The service runs as **root**, with `SupplementaryGroups=nas-workspace`,
only to read the private Pocket/broker files and stage them locally. No service is stopped.

The mount is `192.168.69.15:/mnt/Vault/Workspace` at `/mnt/bigmouth-workspace`, NFS **4.1**
over TCP, `soft,timeo=50,retrans=2,nosuid,nodev,noexec`, 45-second mount timeout, and a
five-minute idle unmount. `timeo=50` is five seconds; soft NFS errors fail the backup rather
than intentionally hanging forever. The overall service timeout is two hours. The
service requires the automount; ordinary boots do not require a reachable NAS.
The IP is deliberate: during preparation `bigmouth.internal` was **not** in aether's
`/etc/hosts` despite the expected hosts-sync pin. Read-only portmapper and NFSv4 NULL
calls succeeded from aether, and mountd EXPORT listed `/mnt/Vault/Workspace` restricted
to `192.168.69.0/24`. Bob's LAN SNAT provides reachability. Nothing was mounted to test it.

### Inputs and layout

Each successful run publishes `/mnt/bigmouth-workspace/aether/state/YYYY-MM-DD/`:

| Backup subdirectory | Source and consistency |
|---|---|
| `pi-pocket/` | `/home/pocket/.pi-pocket`: `pocket.sqlite` through Python's SQLite online backup API (committed WAL transactions included, standalone output DB, `quick_check` checked), plus config.json, push.json, launcher.json, provider-limits.json, uploads, extensions, background, themes and other ordinary data files |
| `upstream-sync/` | `/home/pocket/.local/state/upstream-sync`, including `last-sha` |
| `pr-broker/` | `/var/lib/pr-broker/{processed-requests,merge-attempts,hostile-report,result-cursor}.json`, while holding the broker's shared `merge.lock`; absent not-yet-created JSON files are omitted |
| `archive/` | `/home/pocket/archive`, including pre-upgrade tarballs |

The SQLite backup is transaction-consistent without stopping Pocket. Other Pocket files
are live, per-file copies, **not** an atomic cross-file/application snapshot; an upload or
config change concurrent with backup may belong to a slightly different instant. Symlinks
(including extension dependency links), devices, sockets and lock files are not copied.
Missing required source directories or the broker's initialized `merge.lock` fail the
run (on a fresh host, let the broker initialize once first). Credential directories are not inputs:
`/home/pocket/.config/pi-pocket/secrets.env`, `github-app.pem`, gh's hosts.yml,
`/etc/pr-broker/*.pem`, the 1Password token and kubeconfig remain out. There are also
explicit recursive exclusions for `secrets.env`, `github-app.pem`, `github-app-client-id`,
`hosts.yml`, `*.pem`, `*.key`, `*.env`, `gh`, `.config`, `.cache`, `.local`, SQLite sidecars
and lock names. Broker gh/token caches are never staged. Upgrade archives are copied as
opaque archives of `.pi-pocket`, not unpacked or secret-scrubbed: do not put external
credential files into that data directory or its archives. Config/push files contain
application sign-in/push material by design; treat the backup as private.

The local stage is a fresh **0700** directory in `/var/lib/aether-backup`, with files
0600. After staging, root changes its ownership to `aether-backup:nas-workspace` and
runs the NAS rsync/publish/retention step **as that dedicated user**, not root and not
ubuntu or pocket. Root is squashed on this export; simply adding group 3100 to root is
not a reliable writer identity. The nonzero dedicated uid with primary gid 3100 can
use the Workspace root's supplied 1000:3100 mode 770/inheriting ACL, and owns all newly
created backup directories (0700) and files (0600), so it can replace and prune its own
snapshots without relying on ownership preservation over NFS. Neither pocket nor the
broker gains NAS access. `/var/lib/aether-backup` is root-owned 0711 to let the writer
traverse to its private randomly named stage, which is removed on normal success/failure.
A hard kill/power loss can leave a private stage or hidden NAS partial tree for operator
inspection/cleanup; these are not successful dated snapshots.

Rsync first writes a hidden temporary tree; only a successful transfer is renamed to the
date. A same-day rerun replaces that day's tree (a previous tree is preserved if rsync
fails). Publishing a rerun uses two renames, not an atomic directory exchange: a power
loss between them can leave the previous success in a hidden `.previous` directory.
Only after publishing are strictly named date directories older than **today minus 13
days** pruned; unrelated and hidden directories and old pre-rebuild backups are untouched.
TrueNAS ZFS snapshots provide long-term history. Every failure exits nonzero to systemd;
progress and errors go to the journal. No automatic retry/notification is installed.

No node_exporter service, process or textfile collector was found during preparation.
Nothing is installed for metrics. If a running `node_exporter`/`prometheus-node-exporter`
later has an explicit `--collector.textfile.directory` pointing at an existing directory,
a successful run atomically writes `aether-backup.prom` there, containing
`aether_backup_last_success_timestamp_seconds`. Failures do not advance it; a stopped
exporter or unconfigured collector gets no file. The journal is the current check.

### Applying and the first run (operator only)

These changes are prepared, **not applied**. After separate review and approved transfer
into aether's trusted chezmoi source, as ubuntu:

1. Confirm the NAS prerequisite: the existing `Workspace/aether/` must allow gid 3100 to
   traverse and create `state/` (or pre-create `state/` with an appropriate ACL). Read-only
   RPC proves reachability/export restriction, **not** this directory's ACL. The installer
   and backup never chmod/chown old NAS data. Entries owned 1000:1000 mode 755 cannot be
   deleted by this writer; do not repurpose those old trees. If the first mkdir fails,
   have the NAS administrator grant access to this new subtree, not make the dataset public.
2. Run `chezmoi diff`, review, then `chezmoi apply` on aether. Do not execute a Mac-rendered
   installer. This enables the automount and persistent timer (a catch-up run may occur).
3. Inspect identity/units, then explicitly run the first backup:
   ```sh
   id aether-backup                         # primary gid 3100, no sudo
   getent group nas-workspace
   sudo systemctl cat aether-backup.service aether-backup.timer
   sudo systemctl start aether-backup.service
   sudo systemctl status aether-backup.service --no-pager
   sudo journalctl -u aether-backup.service -n 100 --no-pager
   systemctl list-timers aether-backup.timer
   findmnt /mnt/bigmouth-workspace
   sudo -u aether-backup ls -l /mnt/bigmouth-workspace/aether/state/
   ```
   Confirm a dated tree exists, no hidden failed transfer, and the success journal line.
   As the writer, inspect ownership/modes and use Python SQLite `PRAGMA integrity_check`
   on a **local scratch copy** of the dated DB, not the NFS DB. List the expected four
   subdirectories and verify credential names/lock files are absent. Do not print config
   contents or tokens into logs. Check the automount idles after five minutes without use.

### Restore (operator only)

Use the matching Pocket release for the backup's database schema. Do not open a current
DB with a pre-migration binary. First copy the chosen date **as the NAS writer** into a
private local restore directory; root cannot traverse the writer's 0700 NAS trees after
root squash. For example (substitute the date, use a new empty local directory):

```sh
sudo install -d -o aether-backup -g nas-workspace -m 700 /var/lib/aether-backup/restore-YYYY-MM-DD
sudo -u aether-backup rsync -rpt /mnt/bigmouth-workspace/aether/state/YYYY-MM-DD/ /var/lib/aether-backup/restore-YYYY-MM-DD/
# Take the local restore tree back out of the writer's control before root uses it.
sudo chown -R root:root /var/lib/aether-backup/restore-YYYY-MM-DD
```

For **Pi Pocket**, stop the service; preserve its current data separately, then restore
the standalone `pocket.sqlite` and other files together. Never retain current WAL/SHM
beside an older DB. With Pocket stopped:

```sh
sudo systemctl stop pi-pocket.service
sudo -u pocket mv /home/pocket/.pi-pocket /home/pocket/.pi-pocket-before-restore
sudo install -d -o pocket -g pocket -m 700 /home/pocket/.pi-pocket
sudo rsync -rpt --chown=pocket:pocket /var/lib/aether-backup/restore-YYYY-MM-DD/pi-pocket/ /home/pocket/.pi-pocket/
sudo rsync -rpt --chown=pocket:pocket /var/lib/aether-backup/restore-YYYY-MM-DD/upstream-sync/ /home/pocket/.local/state/upstream-sync/
sudo rsync -rpt --chown=pocket:pocket /var/lib/aether-backup/restore-YYYY-MM-DD/archive/ /home/pocket/archive/
sudo systemctl start pi-pocket.service
sudo journalctl -u pi-pocket.service -n 100 --no-pager
```

Choose a unique preservation path if `before-restore` exists. Check the app, sessions,
uploads and extensions. Dependency symlinks are intentionally absent; recreate them
through the matching Pocket setup if needed. On a rebuilt host, first provision the
matching release/users, then restore, and run `fish -c ai-sync` to fetch the external
secrets again (it restarts Pocket). A full rebuild also needs its kubeconfig separately.

For **the broker**, stop **both** timers and running services before touching state:

```sh
sudo systemctl stop pr-broker.timer pr-lane-merge.timer
sudo systemctl stop pr-broker.service pr-lane-merge.service
# Preserve /var/lib/pr-broker locally first. Restore the four JSON state files only:
sudo rsync -rpt --chown=pr-broker:pr-broker /var/lib/aether-backup/restore-YYYY-MM-DD/pr-broker/ /var/lib/pr-broker/
```

Do not restore `merge.lock`, token caches, merger keys or root-owned opt-in switches from
NAS. Restore credentials with `ai-sync` if rebuilding. An old ledger/quota/cursor can
forget work performed after the backup: **reconcile outstanding/processed requests and
recent merge attempts before re-enabling either timer**. Retain/disable the existing
root-owned merge switches as appropriate during recovery; the backup never changes them.
After reconciliation, `sudo systemctl start pr-broker.timer pr-lane-merge.timer`, then
inspect both journals. Keep the preserved pre-restore state until recovery is accepted.

## Upgrading Pi Pocket

The release is pinned in `home/.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl`
(`version` and `commit`, checked against the tag). `chezmoi apply` does the upgrade in this
order:

1. stop the service and archive `/home/pocket/.pi-pocket` into
   `/home/pocket/archive/pi-pocket-<old version>-<date>.tar.gz` (the service must be stopped:
   the archive holds a live SQLite database),
2. check out the pinned tag and run `npm ci`,
3. install the drop-ins, the service unit and the token helper, turn on the extensions in
   `config.json` (built-in `ask.ts` and `memory.ts` explicitly disabled in favour of
   `ask_jan` and memini),
4. start the service again.

The archive matters: Pi Durable 1.4 (Pi Pocket 0.21.0 and newer) rewrites `pocket.sqlite` the
first time it opens it, and 0.20.0 and earlier cannot read the result.

### Rolling back to 0.26.0

The archive includes the old config and drop-ins. Do not open 0.27 data with
0.26 or merely change the pin: restore the stopped-service archive first.
The installer now retains the full version in its archive name (older runs
used a shortened name). All writes below the pocket home run as pocket.

1. `sudo systemctl stop pi-pocket.service`
2. Choose the **pre-upgrade 0.26.0** archive printed by setup; preserve the new
   data and restore the archive (substitute the actual stamp):
   ```sh
   sudo -u pocket -H mv /home/pocket/.pi-pocket /home/pocket/.pi-pocket-027-rollback
   sudo -u pocket -H tar -xzf /home/pocket/archive/pi-pocket-0.26.0-<date>.tar.gz -C /home/pocket
   sudo -u pocket -H git -C /home/pocket/pi-pocket checkout --detach v0.26.0
   sudo -u pocket -H git -C /home/pocket/pi-pocket rev-parse HEAD
   # Must print 5e13a8b161226cbfef3e696c1bd31b8da110e381.
   sudo -u pocket -H sh -c 'cd /home/pocket/pi-pocket && mise exec -- npm ci --ignore-scripts --no-audit --no-fund'
   ```
3. The restored archive supplies the 0.26 config and drop-ins. Restore the
   pre-upgrade managed source (including pin, skills and drop-ins) through the
   approved workflow **before any later chezmoi apply**, or setup will upgrade
   again. Do not overwrite the archive's drop-ins with these 0.27 versions.
4. `sudo systemctl start pi-pocket.service`; inspect the journal and app.

This discards post-upgrade session changes from the active database; the moved
0.27 folder preserves them for investigation. Neither apply nor rollback was
performed while preparing this change.

## Retirement and verification

Changing the allowlist does **not** delete previously deployed targets or uninstall tools.
The reviewed server cleanup must explicitly remove retired state, launchers, user services,
optional detach sessions and unused packages before updating from the pushed source.
Do not remove the GitHub authentication, signing key, system helpers or shell basics above.
Read-only checks include `chezmoi managed`, `mise ls`, `gh auth status`,
`systemctl status aether-hosts-sync.timer aether-keepalive.service` and
`systemctl --user list-unit-files`.

## Upstream sync — onedr0p/home-ops into Jan's repo

`janpuc/home-ops` grew out of `onedr0p/home-ops`, but it is not a copy: Jan's
cluster is AMD, his apps sit in his own namespaces and his values are his.
Upstream is a source of ideas; nothing of it is merged as it stands.

`upstream-diff` (installed root-owned in `/usr/local/sbin`, run by pocket) is
the deterministic half of it. There is no model in it.

- It makes sure `~/work/home-ops` has the remote `upstream`
  (`https://github.com/onedr0p/home-ops.git`) and fetches it.
- It keeps its cursor in `~pocket/.local/state/upstream-sync/last-sha`. The
  first run looks 14 days back; `--mark <sha>` moves the cursor forward, and
  only to a commit on upstream/main.
- `upstream-diff --json` lists the upstream commits after the cursor, bot
  commits skipped, each with its sha, date, author, subject, PR number, the
  files it changed, the path each file maps to in Jan's repo, whether that
  path is there and whether the commit is relevant.
- Relevance comes from `upstream-sync.yaml`, installed next to the skill as
  pocket (`~/.pi/agent/skills/upstream-sync/upstream-sync.yaml`). It names the
  shared structural paths (`talos/`, `bootstrap/`, `kubernetes/flux/`,
  `kubernetes/components/`, `.github/`, `.renovaterc.json5`, `.mise*`,
  `.justfile`, `mod.just`, `.taskfiles/`), the apps Jan does not follow and the
  paths that are never relevant. The apps both repos have are not listed: the
  tool computes that set from the two trees at run time, because the same app
  sits in another namespace in each repo. The file is read as data (a strict
  subset of YAML), never executed.
- `upstream-diff --upgrade <talos|kubernetes> <version>` says whether
  upstream/main has merged that version, with the upstream PR and the day it
  landed, and lists the non-bot commits around that merge that touch `talos/`,
  `kubernetes/apps/system-upgrade/`, `.mise*` or `.github/` as candidate
  companions. `--window <days>` widens that window (7 days by default).

The `upstream-sync` skill (`~/.pi/agent/skills/upstream-sync/SKILL.md`) is the
other half: it decides what to port, one theme per PR, adapted to Jan's repo,
never secrets, cluster-specific values or Intel-specific bits, published with
`agent-push` and opened with `gh pr create` as
`chore(upstream): port onedr0p <shortsha> <subject>`. Every PR it opens is
lane C: Jan merges it himself.

The standing instructions for the daily **Upstream** session are
`home/.system/pi-pocket-sessions/upstream.md` in this repository. The
installer does not create the session: the main agent creates it with them.

### Talos and Kubernetes upgrades are gated on upstream

The `pr-shepherd` skill owns a PR that names the `talos` or `kubernetes`
group: it reads the target version from the PR body's own update table and
asks `upstream-diff --upgrade`.

- **Not merged upstream: hold.** Nothing is posted, on GitHub or in the
  session; `holding #N for upstream` is remembered once, so later passes stay
  quiet. Jan merges upstream first on purpose: if he has not taken the same
  version, there is probably a reason.
- **Merged upstream: port the companions.** The candidate companion changes
  are read, and the ones that apply go onto the PR's own branch with
  `agent-push`. Renovate stops rebasing a branch it no longer owns; that is
  expected. Then the brief: what changes, the upstream PR and its day, the
  companions ported, kritika on the new head, tuppr's rollout plan (from
  `kubernetes/apps/system-upgrade/tuppr/upgrades/*`), the risk, and one line
  `Jan: ready to schedule #N — reply with a time, or 'now'`.
- When Jan replies with a time, the session schedules the reminder; when it
  fires, it posts `Jan: merge #N now: <url>`. Jan merges the PR himself: the
  agent cannot. After the merge, the TalosUpgrade and KubernetesUpgrade status
  and the node versions are watched read-only, and reported once.

### Reaching Jan: the ask-jan drop-in

Jan has only Pi Pocket's "needs approval" push on, so a `Jan:` line in a
session does not reach his phone. Pi Pocket 0.22.0 and newer can ask him
properly: `host.ask` shows a card in the session, notifies him with that same
push, and gives the answer to the extension alone.

`ask-jan.ts` uses 0.27's tap-to-answer fields: 2–4 distinct answers (strings or
`{label, description}`), with `other: true`. Fewer than two real answers are
rejected without a card; excess options are cut to the first four and reported
in the tool result. Jan's own words return **verbatim**, labelled
`Jan answered in his own words: …`; they are owner instructions, not untrusted
data. A declined or empty answer returns:

> Jan declined / did not answer. Do NOT act on your own recommendation: hold, and do not ask again about this; it stays in the session for him.

The card persists across restart; the tool memoizes the answer before scheduling
and uses the call's idempotent schedule key. If `reminder` is supplied, the
schedule parser checks either a tapped or typed time. A parse/scheduling failure
still returns his words, with `No reminder scheduled; hold unless his instructions say otherwise`.

Use `ask_jan` ONLY for choosing a time for cluster/node maintenance
(Talos/Kubernetes upgrades, reboots), a Home Assistant restart, or work blocked
on something only Jan can do **outside GitHub**. NEVER ask which fix to make:
open the PR with your recommendation and alternatives in its body; the PR is
the question. Never ask the same thing twice; if unanswered, wait. One card per
topic. Never ask for secrets. Publishing is `agent-push`, which does not ask.
All five skills carry this policy and direct agents to memini's
`memory_remember`/`memory_recall` only.

### 0.27 compatibility review

Read all [beta 1–7 release notes](https://github.com/TannerMidd/pi-pocket/releases)
and the clone's `docs/release-notes.md` (the latter is the release-writing guide,
not a changelog). Beta 4 was replaced by beta 5. The notable operational/API changes:

- [beta 7](https://github.com/TannerMidd/pi-pocket/releases/tag/v0.27.0-beta.7):
  “Choices on `host.ask`” adds `choices` (2–4 `label`/`description` pairs),
  `multiple`, `other`, `header`; “A value that is not a choice is refused.”
  The drop-in now uses choices with `other: true`, keeps descriptions short,
  and preserves custom values. Owner-only answers and restart persistence are
  implemented by Pocket's ask/approval host, not by another notification path.
- “New tool name. Pi Pocket's own `ask` tool is reserved.” `ask_jan` has a
  different name. Both built-ins **can be disabled**: `reload.ts` treats only
  `prompt.ts` as required, and `ConfigStore.extensionChoice` checks
  `disabledExtensions` before `enabledExtensions` and defaults. `ask.ts` and
  `memory.ts` are on by default, not in `OFF_BY_DEFAULT`; setup adds them to
  `disabledExtensions`, removes stale enable entries, and explicitly enables
  our drop-ins, triggers and schedules. Existing owner/auth settings survive.
- All betas say “Back up `~/.pi-pocket` first.” The stopped-service archive
  already does this automatically whenever the commit changes; full old
  versions are now kept in archive filenames. No additional database migration
  is identified in these beta notes; keep the archive regardless.
- Node requirement remains `>=22.19`; pocket's pinned **24.22.2** exceeds it
  and includes the upstream launcher's October security fixes. CLI flags
  (`--host`, `--port`, `--data`, `--cwd`) remain compatible. No service-unit or
  mise pin change is needed. The beta-update UI setting is unnecessary for a
  git checkout pinned by this installer.
- All four drop-ins still use `pocketApi = 2`, Durable 1.4.0's `output` result
  shape, `GenerationTask`/`ToolTask` hooks, sections, memo and schedule APIs.
  No memini/approvals/web code change is required. The ask host subset now uses
  branded `ConversationId`/`TaskId` and `Context` and is checked against
  0.27's actual `PocketHost`.
- Betas 1–6 add design systems/scans, gallery reach information, quote replies,
  priority lists and optional host surfaces (`roleOf`, snapshot scroll). They
  do not require changes to these server-only drop-ins. Beta 7's scan isolation
  and security fixes ship as upstream code, not local patches.

### Applying this upgrade (operator only)

Review these uncommitted changes and transfer them to aether's trusted source
through the separately approved workflow. As ubuntu on aether, run
`chezmoi diff` then `chezmoi apply`; do not execute a locally rendered script.
Keep the printed pre-upgrade archive path. Verify the checked-out commit,
`sudo systemctl status pi-pocket.service --no-pager`, and
`sudo journalctl -u pi-pocket.service -n 100 --no-pager` for load errors.
Read only the extension config keys (not the owner token):

```sh
sudo -u pocket -H python3 -c 'import json; c=json.load(open("/home/pocket/.pi-pocket/config.json")); print({k:c.get(k) for k in ("enabledExtensions", "disabledExtensions", "approvals")})'
```

In the app verify all four drop-ins are on, built-in Ask and Memory are off,
and, on the next legitimate maintenance question, that a choice and Other work
and the answer reaches the agent. Do not create duplicate test cards in a live
session. Keep the archive until the upgrade is accepted.

## Home Assistant configuration in git

Jan's Home Assistant runs on HAOS on another PC, at `https://hass.janpuc.com`
(`$HA_URL` and `$HA_TOKEN` are in pocket's environment). Its configuration
lives in the private repository `janpuc/home-assistant`: `configuration.yaml`,
`automations.yaml`, `scripts.yaml`, `scenes.yaml`, `packages/` and
`blueprints/`. Never `.storage`, `secrets.yaml` or a HACS-managed directory.
The HAOS **Git pull** add-on pulls that repository every five minutes
(`git_command: pull`, `auto_restart: false`); the pull only changes the files,
so a merged change is live after the reload service that owns it has run. Jan
merges every pull request to that repository himself.

The agent's GitHub App (`janpuc-agent`) needs access to it. The token helper
asks for `home-ops`, `dotfiles`, `BC250` and `home-assistant`, and falls back to
the older three repositories, with a log line, when the installation does not
have the new one yet, so `gh` keeps working until Jan adds
`janpuc/home-assistant` to the App installation. The setup script clones the
repository into `~pocket/work/home-assistant` and skips it, without failing,
while the repository or the installation does not exist; the next run retries.

### What runs without asking Jan

`approvals.ts` asks Jan on his phone before a bash command changes a shared
system. Home Assistant service calls are asked as well, with one exception: a
single simple `curl` to one `/api/services/` URL on `hass.janpuc.com` or
`$HA_URL` runs without a prompt when the service is one of

- `light.turn_on`, `light.turn_off`, `light.toggle`, `scene.turn_on`;
- the reload services: `automation.reload`, `script.reload`, `scene.reload`,
  `homeassistant.reload_core_config`, `homeassistant.reload_all`,
  `group.reload`, `template.reload`, `input_boolean.reload`,
  `input_select.reload`, `input_number.reload`, `input_text.reload`,
  `input_datetime.reload`, `input_button.reload`, `timer.reload`,
  `zone.reload`.

Everything else still asks: `script.*`, `switch.*`, `homeassistant.restart` and
`homeassistant.stop`, every config-entry call and every Supervisor call (the
token is no Supervisor admin: `/api/hassio/info` answers 401). The command has
to be one invocation: no chaining, no substitution, one service URL, a POST.
`home/.system/pi-pocket-extensions/approvals.test.ts` covers every allowed
service and the asking cases.

### The configuration loop

The `home-assistant` skill owns it:

1. branch `agent/<topic>` from `origin/main` in `~/work/home-assistant`;
2. the smallest change that carries the topic;
3. publish with `agent-push`, then `gh pr create -R janpuc/home-assistant`,
   whose body names exactly which reload applies the change, or "needs a
   restart" and why;
4. wait for the CI of the pull request (`frenck/action-home-assistant`);
5. leave the PR for Jan to merge: the PR is the question, not another card;
6. after the merge, wait up to six minutes for the Git pull add-on, check that
   the change is in Home Assistant (`GET /api/config/automation/config/<id>`
   with the numeric id in the entity's attributes,
   `GET /api/config/script/config/<script_id>`, or the state of the entity it
   touches), then call the named reload service and verify the effect.

A restart is a user-facing outage: eight of Jan's ten Shelly wall switches are
in `detached` mode and drive smart bulbs through Home Assistant automations
(Hall 1, Hall 2, Server Room, Bathroom 1, Office, Bedroom, and Living Room
outputs 0 and 1; Bathroom 2 is in flip mode). While Home Assistant is down
those eight switches do nothing at all. The agent never restarts Home
Assistant without an `ask_jan` yes, and says why.

### Jan's manual steps

1. Create the private repository `janpuc/home-assistant` with the
   configuration, and add `janpuc/home-assistant` to the `janpuc-agent` App
   installation (contents and pull requests write).
2. Add the **Git pull** add-on in Home Assistant OS, pointing at that
   repository, with `git_command: pull`, `auto_restart: false` and the `main`
   branch.
3. Add a pull request workflow to that repository running
   `frenck/action-home-assistant` on the configuration files.

## PR shepherd — Step 2: separate merge broker

The **PRs** session uses `pr-shepherd/SKILL.md`. `pr-lane <N> [--json]` and
`pr-lane --all [--json]` read home-ops from GitHub and konflate without caching.
Every result includes the head SHA, lane, fired rules and supporting facts.
It reads a paginated three-dot compare of the current main SHA and head (including
old rename paths), head-specific statuses/check runs, and bot-atlas' marked kritika
comment. `facts.main_sha` and `facts.merge_base` identify the compared main and
merge-base. GitHub only includes up to 300 files on compare's first page: a result
at that cap, incomplete commit pagination, or a main SHA that moves during
classification means **wait**, never an assumed complete diff.

GitHub GraphQL actor records authenticate mutable evidence: the kritika comment's
current editor must be null or `bot-atlas`, and every historical content editor
must be `bot-atlas`. The PR body's current/history editors have the same rule;
every title-rename, label-add and label-remove event must be by `bot-atlas`.
Every ready-for-review, convert-to-draft, base-change and base-force-push event
must be by `bot-atlas` too, so a PR that was drafted or retargeted by an
untrusted actor is C even when it is ready again. An offending actor produces C
(`kritika comment edited by <login>`, `PR metadata changed by <login>`,
`draft state changed by <login>` or `base ref changed by <login>`); unknown or
deleted actors also cannot authorize merging. All timeline and edit-history
pages must be complete or the result is
**wait**. The unfiltered timeline is paginated because GitHub's `totalCount`
includes other event types even with an `itemTypes` filter. Kritika state and
confidence still come from its head-specific commit status; pocket only has
statuses:read. PR text, labels and comment author/marker alone are not trusted.

The update type comes from the PR body's Renovate update table, which is
bot-authored and edit-checked. Only the **first** table of the body is read,
and only when it appears before the release notes (`---`, `<details>`,
`### Release Notes`, `### Configuration`): every later table is upstream
release-note text that Renovate copies verbatim, so it is never read. That
table must have exactly one `Update` column and a `Package` column; the
`Update` column is read per row and the most severe type wins
(major > minor > patch > digest); a missing, malformed or unknown value is
**wait**. Repository labels can be renamed without
leaving a PR timeline event, so a label never qualifies a lane: only a
conservative C trigger such as a `type/major` label may come from labels.

The base must be **main in janpuc/home-ops**. The final recheck requires that base,
the unchanged head, and the same main SHA. A main merge therefore applies the
classified merge-base-to-head changes, not an attacker-selected temporary base's
PR-files diff. Retargeting to another branch after the final check makes GitHub
merge into **that branch, not main**. Retargeting back to main does not hide any
paths because the policy diff was always computed against main. GitHub still
serializes the actual merge with concurrent main updates; external signals are
not an atomic transaction with that merge. The comment's last
reviewed commit must match the head; its confidence, risk and findings must
parse. Severity counts may wrap across lines, but must be parseable and sum
to the findings total; missing counts for positive findings mean **wait**, not
zero P1. Explicit “No findings” means zero. Konflate's list and rendered diff
must both be ready for that head. Rendered CSS is not included in the output.

- **wait** takes priority: draft, pending/missing/stale/unparseable evidence.
  C reasons remain visible even when waiting. Explicit null namespaces mean
  empty only for a zero-resource impact; this normalization is reported.
- **C**: non-Renovate author (including Jan and the agent), Talos/Kubernetes
  groups (named in the title, the labels, the branch or the body's package
  column), protected paths/namespaces, CRDs, blocking/render failures, high risk,
  any P1, confidence below 3, unsuccessful kritika, or failed/cancelled/timed-out/
  action-required CI. Kritika `error` is C, “review incomplete”, not wait.
  SKIPPED and NEUTRAL checks are acceptable. A body-derived major update that
  touches `.renovaterc.json5` or root `.mise*` changes (including `.mise/`) is
  C, as is a `type/major` label. Never merge C as the agent
  or ask for merge approval: send a one-screen brief plus a **`Jan:`** line.
  A later phase owns Talos/Kubernetes groups.
- **A**: a body-derived digest/patch update type, routine render without caution,
  confidence at least 4,
  low risk and no P1, with no wait/C rule. Review the evidence, then request
  a broker merge. The optional broker timer also handles A without an agent.
- **B**: everything else that is not wait/C. Review the diff, kritika, konflate
  and upstream release notes; repair real findings, wait for the new head's
  evidence, and classify again before requesting a broker merge. Two PRs at a
  time, oldest first.

For both A and B, the agent submits the exact fresh `pr-lane` head:

```sh
/usr/local/sbin/pr-merge-request <N> <sha-pr-lane-reported>
```

This unprivileged helper prints the unique JSON result path under
`/var/spool/pr-broker/results/`. Wait for and read that exact file: `merged`,
`refused` (including classifier reasons), `error`, or `dry-run`. Normally the
minute timer picks it up within two minutes; an active broker run can delay it.
On refused/error/dry-run report and stop. A missing result is not permission to
resubmit or assume success. Never retry with `gh pr merge` or merge APIs.

`pr-merge-request` deliberately does **not** ask Jan: the separate broker
makes the decision. `agent-push` and opening, editing, commenting on or
marking a PR ready do not ask either (since 2026-10-29: the main branches are
ruleset-protected). Every other write still asks, including direct
`gh pr merge`, closing, reviews, and API merges. Chaining a write onto a request does not
exempt the write. The approvals extension remains a mistake detector, not a
sandbox. The **GitHub restrict-updates ruleset**, not that extension, prevents
pocket's App from updating main. Do not use admin bypass or auto merge.

### Verified publishing

Local commits use pocket's SSH key but are **UNVERIFIED as the bot on GitHub**;
those pushed with git cannot satisfy home-ops' signatures rule. Always publish
with `/usr/local/sbin/agent-push`, never `git push`. From a clean feature branch,
`agent-push --dry-run` previews the operation. The real command creates a remote
branch at the merge-base with origin/main if needed, then creates one GitHub-
signed commit using GraphQL `createCommitOnBranch`, with a compare-and-swap
`expectedHeadOid`. It preserves binary file bytes and deletions, refuses
main/master, diverged remote history, workflows, symlinks/submodules and mode
changes (also new executables, unsupported by fileChanges). The headline is
the last local subject and the body lists all local subjects. Only after fetching
and verifying tree equivalence does it `reset --keep` to the API commit and set
the upstream. Old local commit SHAs are replaced; do not push them afterwards.
If publication succeeds but verification/reset fails, stop and inspect the
remote and local branch rather than retrying or force-pushing blindly.

### Accounts, runtime and permissions

- `pocket`: no sudo, `/home/pocket` is now **0700**. Its existing App can still
  write feature branches, PRs and issues in its installed repositories; it must
  not be a bypass actor for home-ops main. Its service restarts during setup so
  it picks up membership of the dedicated `pr-requesters` group. Existing
  interactive pocket shells need a fresh login too.
- `pr-broker`: system user, `/usr/sbin/nologin`, no sudo/supplementary groups
  except `pr-requesters`, home `/var/lib/pr-broker` **0700**. Neither account
  can read the other's home. No code or configuration is loaded from pocket.
- `/etc/pr-broker`: **root:root 0755**; `merger.pem` and `client-id` are
  **root:pr-broker 0640**, written by `ai-sync`. Provision the new GitHub App
  `janpuc-merger` with contents/PRs write, checks/statuses read, installed on
  **janpuc/home-ops only**. Store its fields `MERGER_APP_ID`, `MERGER_APP_SLUG`,
  `MERGER_APP_CLIENT_ID`, `MERGER_APP_PRIVATE_KEY` in
  `op://Kubernetes/janpuc-merger`. The broker needs only client id and private
  key; the other fields document the App. Ensure aether's 1Password service
  account can read the item. A missing item only warns in `ai-sync`, retaining
  previous credentials. New installations without credentials produce errors,
  never merges.
- `/var/spool/pr-broker` is root-owned. `requests/` and `staging/` are
  **pr-broker:pr-requesters 3770** (setgid + sticky), not root-owned: POSIX
  sticky semantics require the broker to own the directory to delete
  pocket-owned files. Inputs are public **0644** even with a private umask. The helper writes
  completely in `staging/`, then renames into `requests/` on the same filesystem.
  The broker never scans or cleans `staging/`, avoiding partial-submission races.
  `results/` is **pr-broker:pr-requesters 2750**, result files **0640**:
  pocket can read but not modify results. Only the broker owns the writable
  private quota state and shared service lock in `/var/lib/pr-broker`.
- Code in `/usr/local/sbin` and the runtime in `/opt/pr-broker` are root-owned.
  Each installer run first reasserts root:root 0755 on those directories,
  `/etc/pr-broker`, and their ancestors, refusing symlinked trust directories.
  The broker checks its executable, pr-lane, runtime and config paths, including
  lexical ancestors and resolved symlink targets: root-owned, no group/world write.
  Node **24.22.2** and gh **2.102.0** match pocket's pinned mise versions, but
  are downloaded separately from official arm64 releases and verified against
  **repository-pinned SHA256 values**, not checksum files fetched at installation.
  Official manifest source URLs are beside the pins. Aether was verified aarch64;
  other architectures fail closed. This deliberately avoids executing mise, shims,
  pocket's installed binaries or its config at runtime. The stable absolute
  paths `/opt/pr-broker/bin/{node,gh}` point into root-owned versioned releases.
  `pr-lane` and both runners have that absolute Node shebang; the broker passes
  an absolute `--gh` path to the classifier. CLI `--node`/`--lane`/`--gh` path
  overrides exist for testing; installed units never use overrides. The units
  start `/usr/local/sbin/pr-broker-lock`, a root-owned static shell script that
  takes the shared `flock` and runs one runner under it: requests never wait
  and log `skipped: lock held`, lane A waits 300 s and logs when it gives up.
  Only root
  can change the units or launch commands as pr-broker. Keep runtime pins in
  `pr-broker-runtime.sh` in step with `pi-pocket-mise.toml` (tested).

The broker mints an RS256 App JWT and a **fresh per-run installation token**,
explicitly restricted to home-ops and contents/PRs write, checks/statuses read.
The token stays in memory/child environments, never gh config or disk; child
output on failure is suppressed to avoid credential leaks. `gh` uses a private
config directory in the broker home; no mise data directory is needed.
Services protect `/home`, use a fixed system PATH and absolute executables,
`ProtectSystem=strict` with only broker state/spool writable, no capabilities,
no privilege gains, private devices/tmp, restricted address families and
kernel protections. Node JIT requires executable mappings, so
`MemoryDenyWriteExecute` is deliberately not set.

### Deterministic merge path and switches

`pr-broker.timer` runs requests every minute; `pr-lane-merge.timer` runs lane A
on the half hour. Both run as pr-broker under the same `flock`, taken by the
root-owned `pr-broker-lock` wrapper: requests never wait and log
`skipped: lock held` when they skip, lane A waits up to 300 s and logs when it
gives up. Waiting never holds the lock, so neither runner starves the other.
Every lane A run logs its mode (`DRY-RUN`/`ENABLED`) and its candidate count.
For requests,
the broker ignores the submitter's claims, freshly classifies the numeric PR,
and merges only **A or B with the exact requested head**. Lane A processing
selects oldest first, at most five, reclassifies before each merge and stops
at the first refusal/error. Both use only:
`gh api -X PUT repos/janpuc/home-ops/pulls/N/merge -f merge_method=squash -f sha=<sha>` (the REST merge, pinned to the head server-side; `gh pr merge` refuses client-side because every PR shows BLOCKED under the restrict-updates rule, which ignores the merger's bypass).

**Both behaviours are off by default.** These regular, root-owned files
(with no group/world write permission) independently permit real merging:

- `/etc/pr-broker/requests.enabled`
- `/etc/pr-broker/lane-a.enabled`

The installer **never creates them**. Without one, eligible work produces
`dry-run` results; malformed/ineligible work is still refused. Removing the
files stops future merge decisions, not an already authorized in-flight call.
Stop both services first for an immediate maintenance window.

Requests are strictly two fields (positive safe-integer PR, lowercase 40-hex
head), at most 512 bytes; at most 100 correctly named regular request files
are processed per run. Directory scanning uses bounded memory but must examine
all entries so leftover hostile entries cannot starve the request budget.
All names, file types and contents are hostile. lstat + O_NOFOLLOW/O_NONBLOCK + fstat,
single-link checks and bounded reads prevent symlink/FIFO/device/race tricks.
Malformed entries get refusal results and are unlinked; empty directories are
removed, nonempty hostile directories are left but never recursively traversed.
At most 20 hostile entries are handled per run, so a flood of hostile
directories cannot publish unlimited results. A leftover that was already
reported is remembered by name, inode and mtime in a small private set and is
never published a second time. Correctly named regular requests are handled
first; other entries never consume
their 100-request budget. Hostile cleanup logs one summary per run with a count
and at most five leftover names, not a line per hostile entry. Processed inputs are deleted only after writing an atomic JSON
result using **link(2) no-replace publication**, never rename-over. A private
`processed-requests.json` ledger reserves IDs before classification, including
malformed/hostile named inputs, and refuses replays even after a result expires.
The ledger never evicts IDs: it is capped at 100,000 and fails closed when full.
Operator maintenance then requires stopping both services and reviewing/draining
the queue; do not clear the ledger and permit historical IDs to be replayed.
Results are retained for seven days; a rotating cursor examines the result
directory in bounded steps, so every entry is reached over successive runs.
Both paths share **at most 10 merge attempts per rolling hour**, persisted
before the API call, including failures/timeouts. Corrupt quota state fails
closed. Do not reset it to bypass the limit. Hard crashes/power loss are not a
transaction spanning GitHub and disk: inspect uncertain merges instead of
blindly retrying. `dry-run` and refusals do not consume the merge quota.

### Privileged pocket-path audit

- Account bootstrap uses `useradd --no-create-home`, not root-written skeleton
  files. The only root operation on the home itself opens `/home` and then
  `pocket` with O_DIRECTORY/O_NOFOLLOW, creates relative to the parent descriptor,
  and uses fchown/fchmod on that descriptor. It cannot follow a pocket symlink.
- All home subdirectories (config/mise/pi-pocket, work, kube, skills, archive,
  scratch, ssh, extensions) are created with `sudo -u pocket -H install -d`.
- Skill/config/extension content is sent on stdin into a pocket shell; initial
  secret files use pocket's install. Profile appending uses pocket's tee. Token
  removal, archives, git/mise/npm, signing keys, symlinks and config.json updates
  also run as pocket. Home chmod, existence tests and grep run as pocket.
- `ai-sync` sends model secrets, agent key and client-id on stdin into
  `sudo -u pocket -H sh`; its private installer temp files stay private. No root
  install/tee/mkdir follows any path beneath pocket's home. The merger credentials
  are separate root writes under `/etc/pr-broker`, never sent to pocket.

### Apply and verify (operator steps; not performed while preparing changes)

1. Review and transfer these uncommitted source changes into aether's trusted
   chezmoi source by the separately approved workflow. On aether, as ubuntu,
   run `chezmoi diff`, then `chezmoi apply`. Setup retires any running
   pocket-owned draft, installs the isolated runtime/account/units, enables
   both **dry-run** timers and restarts Pi Pocket (new group membership).
   Confirm neither switch exists before proceeding; a reapply intentionally
   preserves existing operator switches.
2. Provision/install `janpuc-merger` as above, create its 1Password item and
   permit the service account to read it. Run `fish -c ai-sync`. Verify without
   printing secrets:

   ```sh
   sudo stat -c '%U:%G %a %n' /etc/pr-broker /etc/pr-broker/merger.pem /etc/pr-broker/client-id /var/lib/pr-broker /home/pocket /var/spool/pr-broker/{staging,requests,results}
   id pr-broker
   id pocket
   sudo -u pocket test ! -r /etc/pr-broker/merger.pem
   sudo -u pocket test ! -r /var/lib/pr-broker
   sudo -u pr-broker test ! -r /home/pocket
   sudo systemctl start pr-broker.service pr-lane-merge.service
   sudo journalctl -u pr-broker.service -u pr-lane-merge.service -n 50 --no-pager
   sudo systemctl status pr-broker.timer pr-lane-merge.timer --no-pager
   ```

   As pocket, use a fresh `pr-lane N --json` and submit its head with
   `pr-merge-request N <head>`. Read the printed file after the timer runs;
   expect `dry-run` for A/B, `refused` for C/wait/head mismatch. Never enable
   to work around authentication/runtime/classifier errors.
3. **Only after deployment and dry-run verification**, the main agent/Jan
   applies and verifies the GitHub main-branch **restrict updates** ruleset:
   only Jan (admin), Renovate (`bot-atlas`) and `janpuc-merger` may update main;
   **janpuc-agent has no bypass**. Preserve the existing PR/signature/check
   protections. Confirm the effective rules and actor IDs read-only; do not
   probe by merging a live PR. Until this rule is active, Step 2 is not a
   security boundary: pocket's own token can still merge.
4. With that GitHub boundary verified, Jan explicitly enables each desired
   behaviour (either or both), then inspects its journal/results:

   ```sh
   sudo install -o root -g root -m 644 /dev/null /etc/pr-broker/requests.enabled
   sudo install -o root -g root -m 644 /dev/null /etc/pr-broker/lane-a.enabled
   sudo systemctl start pr-broker.service pr-lane-merge.service
   ```

   These commands are operator opt-in, **not** installer actions. Verify the
   first authorized merge's head/state with read-only `gh pr view`; verify Flux
   read-only afterwards. No live merge or GitHub write is part of preparation.

### Rollback / emergency stop

```sh
sudo systemctl disable --now pr-broker.timer pr-lane-merge.timer
sudo systemctl stop pr-broker.service pr-lane-merge.service
sudo rm -f /etc/pr-broker/requests.enabled /etc/pr-broker/lane-a.enabled
```

Keep the GitHub ruleset: Jan/Renovate can still merge, pocket cannot. For a
credential compromise, revoke the merger App installation/key in GitHub (an
already minted token can otherwise live up to an hour), rotate the 1Password
key and rerun `ai-sync`. Do not roll back by granting pocket main access.
If reverting dotfiles/runtime, keep timers disabled and switches absent until
revalidated; `chezmoi apply` re-enables dry-run timers. Keep the private quota
state and inspect pending inputs/results before re-enabling; do not replay a
backlog without review. No need to delete the account or its state to stop it.

### Remaining threat boundary

Pocket can publish feature branches, edit PRs/issues, request eligible A/B
heads and consume the allowed merge quota. It retains its existing model,
memini, Home Assistant and read-only cluster access: this change does not
sandbox those capabilities. It can flood the public request spool, withhold
requests, delete its own pending files or cause denial of service/disk growth;
request/read/merge limits bound classification and merging, not directory-scan
work or disk usage. Operators must monitor
the spool and journal and clean nonempty hostile directories during a stopped
service window. It cannot read the merger key/token via home/config permissions,
replace the trusted classifier/runtime/units, write enable switches or results,
or (after the ruleset) use its own App to merge/update main. Trusted evidence
providers (GitHub, bot-atlas/kritika and konflate), the classifier's policy,
root/ubuntu and the downloaded release supply chain remain trusted. A/B is a
deterministic policy, not proof a change is harmless; B's agent review is
advisory, not separately enforceable by the broker. Head pinning prevents a
changed head from merging, but does not freeze every external signal after
classification or serialize Renovate/Jan with the broker.

### Local validation

Upgrade preparation checked the exact beta 7 checkout in `/tmp/pi-pocket-027`
against aether's read-only 0.26 checkout. On local Node **26.13.0**:

- Full dotfiles suite: **95 tests passed, 0 failed** (including 10 ask-jan tests).
- All four drop-in suites also ran as scratch copies importing their actual
  source with **real 0.27 packages**, instead of the unit tests' package fakes:
  **33 tests passed, 0 failed**. HTTP calls still used each suite's local fakes.
- Strict `tsc --noEmit` passed for all four source drop-ins plus an adapter
  calling each factory with 0.27's actual `PocketHost`. To reproduce, copy the
  four source files (not tests) into the clone's `drop-in-check/`, add
  `host-check.ts` importing `PocketHost` from `../src/server/host.ts` and the
  factories, and call `ask(host); approvals(host); memini(host); web();` with
  `declare const host: PocketHost`. Run from the clone:
  ```sh
  ./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --skipLibCheck --allowImportingTsExtensions --types node drop-in-check/ask-jan.ts drop-in-check/approvals.ts drop-in-check/memini.ts drop-in-check/web.ts drop-in-check/host-check.ts
  ```
- Real beta 7 launcher/server ran on **127.0.0.1:18787**, with a scratch HOME,
  data directory and cwd, no production keys, and a dummy memini key to ensure
  its tools registered. Authenticated `GET /api/extensions` showed all four
  drop-ins enabled, the expected tools and hooks, **no load errors**, and
  built-in `ask.ts`/`memory.ts` disabled. The server was then stopped. No model
  turn, production network call or live phone notification was exercised.
- Rendered installer passed ShellCheck and `sh -n`; `git diff --check` passed.

The inherited Mac PATH includes spaces; one existing runtime sandbox test
interpolates PATH into shell text without quoting. Run the suite with a clean
PATH (Node, Homebrew, `/usr/bin:/bin:/usr/sbin:/sbin`) to avoid that unrelated
fixture failure. No production runtime code was changed for this.

```sh
node --test home/.system/*.test.cjs home/.system/pi-pocket-extensions/*.test.ts
chezmoi --source "$PWD/home" --override-data '{"chezmoi":{"os":"linux"}}' execute-template < home/.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl > /tmp/pi-pocket-setup.sh
shellcheck /tmp/pi-pocket-setup.sh home/.system/pr-broker-runtime.sh home/.system/pr-broker-lock home/.system/pi-pocket-gh-token
sh -n /tmp/pi-pocket-setup.sh
sh -n home/.system/pr-broker-runtime.sh
sh -n home/.system/pr-broker-lock
sh -n home/.system/pi-pocket-gh-token
git diff --check
```

Render only: do not execute the setup during validation. Tests use local bare
repos, fake gh/pr-lane paths and synthetic credentials/switch ownership, not
shared-system writes. They cover validation, head/lane mismatch, dry-run,
shared quota, malformed inputs, symlinks/FIFOs/hardlinks/races, flood bounds,
result permissions, token scope, five/run and stop-first-failure semantics,
approvals (including the Home Assistant services that run without a prompt) and
installer/runtime invariants. Verify units with
`systemd-analyze verify` on Linux (passed on aether's systemd 255 with only
unrelated existing executable-bit warnings on Oracle monitoring units). This
checks unit syntax, not ExecStart arguments behind the lock wrapper. Actual App
authentication and hardened runtime need the operator dry-run checks above.
