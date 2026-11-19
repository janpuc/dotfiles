# Sisyphus work host

Sisyphus is Jan's macOS 26.6 M3 Pro with 18 GB RAM, hostname `sisyphus`. It runs the
single `work` project at `~/Work/work` and at most five project and task agents.
Hermes is the laptop dispatcher and Rex client. Aether runs personal projects and
`dotfiles`, the platform owner. Work never moves to aether.

`dotfiles` may SSH to sisyphus only for `agent ls`, `agent restart all` and
`chezmoi update`. It never reads `~/Work`. Jan or the work agent performs all
other sisyphus setup in its own tab. Work asks `agent ask dotfiles` for platform changes.
The Work migration is a separate operation after this build, not part of deployment.

## Host setup and identities

The registry assigns sisyphus root `~/Work`, guard `work`, namespace `work`, no
memini home, providers `all`, vault `Work` and `maxAgents: 5`. A project can narrow
providers, never widen a restricted host policy. The runner removes cached and plain
keys for disallowed providers. This is configuration, not a network sandbox. Keep
the selected model consistent with the allowed providers. Host model scopes filter
the same provider list, while project key stripping is applied at launch.

Chezmoi installs the runner, standards, Work mise trust and tools on sisyphus, but
not aether's systemd units. Python, Node, Pi and restic come from mise. The runner
also includes Homebrew and the installed Rex CLI in PATH:
`/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`.
LaunchAgents use `mise exec -- python3`, so Apple's old system Python is not used.
The user must be logged in for the backup LaunchAgents. No secrets are in plists.

Two unmanaged service account files live on sisyphus, both mode 0600:

- `~/.config/op/sisyphus.env` is the existing Kubernetes account, used for shared
  model keys, the sisyphus memini key, package GitHub login and Pushover keys
- `~/.config/op/sisyphus-work.env` is a second account scoped only to Work

Each has a single `OP_SERVICE_ACCOUNT_TOKEN=...` assignment. Never commit them.
`ai-sync` scopes Work reads to the second account without exporting its token into
agent processes. Project secrets must reference `op://Work/` on sisyphus. Aether
project secrets may never reference that vault. The registry render fails on either
cross-vault mistake. Fill `op://Work/github/GH_TOKEN` before the first `ai-sync`.
The runner loads it only in the work project environment.

Memini uses `op://Kubernetes/memini/MEMINI_API_KEY_sisyphus`, not Jan's key.
`MEMINI_HOME` is unset in fish and removed by the runner. Tasks use `work`, tagged
`ticket:<ID>` or `task:<slug>` with project, task id and ticket metadata. There are
no task child namespaces and no personal/jan inheritance. The legacy work namespaces
are migration history, not a source of new task namespaces.

## Restricted request transport

Sisyphus has a dedicated `~/.ssh/work-inbox` ed25519 key. Its public half goes into
`home/.chezmoidata/work-inbox.yaml`. Aether's additive authorized_keys modifier
preserves operator keys and manages only the line tagged `agents-work-inbox`.
It pins sisyphus's tailnet source `100.103.124.32` and forces
`/home/ubuntu/.local/bin/agent-run --remote-inbox`, with no PTY, forwarding or user rc.
Pin aether's SSH host key independently on sisyphus before testing this connection.

The endpoint accepts only `deliver` and `fetch`, never a shell. Delivery requires
sender `work`, an active initialized aether target, a valid id and a payload under
32 KiB. Fetch returns only replies addressed to work and acknowledges previously
persisted ids. Replies wait in aether's `~/.local/state/agents/remote-inbox/work`.
Work polls through its inbox extension and imports them without changing accepted
local statuses. Interrupted acknowledgement is retryable. The connection disables
SSH agent use and multiplexing so it cannot reuse an unrestricted aether connection.
Jan still accepts each imported reply in the Work tab. Any aether project can queue a
reply to Work without connecting to sisyphus. Empty or invalid public keys preserve the
existing authorized_keys. Revoke the identity by removing its managed line on aether
in a separately reviewed edit, then clear the configured public key.

## Access between the hosts

All three hosts pin each other's ED25519 host keys in `~/.ssh/known_hosts_agents` through
`HostKeyAlias`, rendered from `home/.chezmoidata/agent-ssh.yaml`. Verify a host key on the
host itself with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` before committing it.

dotfiles reaches sisyphus with aether's `~/.ssh/main-sisyphus` key. On sisyphus the authorized_keys
modifier adds it as the line tagged `agents-main`, from aether's tailnet address only, with no
PTY, forwarding or user rc, forced to `agent-run --main-endpoint`. The endpoint accepts exactly
`agent ls`, `agent restart all` and `chezmoi update`, nothing else and no arguments. chezmoi
runs without a TTY, so scripts needing sudo fail there and Jan runs `chezmoi apply` locally.
The forced command is the only limit, the guard no longer asks.

Jan's hermes dispatcher needs a login shell, so it is Jan's identity, never an agent key. Until
`agentSsh.hermesSisyphus.publicKey` and the sisyphus host key are filled it keeps the old
mac-models key and LAN address, without pinning. The planned path is his 1Password SSH key over
the tailnet name with `HostKeyAlias sisyphus`, the line tagged `agents-hermes`, restricted to
hermes's tailnet address without forwarding. The modifier keeps every other line.

Commits are signed and authored as janpuc on every host. hermes signs with Jan's 1Password
key, aether with its own key and sisyphus with `~/.ssh/sisyphus-sign`, generated by the host
script and registered on GitHub as a signing key only. sisyphus has no dotfiles push URL and its
GitHub token is `op://Kubernetes/sisyphus/GH_TOKEN` when that item exists, meant to read only the
private Pi packages. Until then ai-sync falls back to aether's token, Jan's choice on 2026-11-19.

## AWS and EKS

For WBD, configure a native AWS CLI `sso-session` on sisyphus with the start URL,
SSO region, account id and role supplied by Jan. For example, replacing each value:

```ini
[sso-session WBD]
sso_start_url = <WBD start URL>
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile WBD/account/role]
sso_session = WBD
sso_account_id = <account id>
sso_role_name = <role>
region = us-east-1
```

In the Work tab run `aws sso login --profile WBD/account/role --use-device-code`.
Jan opens its URL on the laptop. The SSO cache stays on sisyphus for its normal life.
Do not run the laptop's SAML discovery flow on sisyphus.

For DSC, DTC and WB, Jan authenticates through Okta and saml2aws on hermes, then
runs `work-creds <profile>` there. It uses `aws configure export-credentials
--profile <profile> --format env`, refuses output without `AWS_SESSION_TOKEN`, and
sends only that profile over SSH. When env output omits expiry, it obtains Expiration
from process output and verifies it still belongs to the same keys. The receiver
validates expiry and atomically replaces that profile in `~/.aws/credentials` mode
0600, retaining the other profiles. It records expiry in `expiration`. It does not
refresh credentials or push long-lived keys. Re-push after expiration, never print
or paste credentials into a conversation.

For `k8s-sync`, Jan first supplies the Work AWS inventory and profile metadata from
the laptop. This is work configuration, never a copy into an aether workspace.
On sisyphus the function uses the Work service account for `op://Work/K8S` discovery.
Generated work kubeconfigs live in `~/.kube/clusters`, with legacy direct files
included in the wipe inventory. `~/.kube/config` remains the homelab config and is
never wiped. AWS, EKS, terraform and tofu changes ask Jan. The work guard allows
AWS read-only verb prefixes describe-, list-, get-, head-, lookup-, search-, batch-get-
and validate-, plus scan, query, wait, help and S3 ls. All other AWS operations ask,
including S3 downloads and any new write verbs. Terraform and tofu apply/destroy/
import/taint/state rm/state mv and prod-profile assumptions also ask, alongside every
existing shared-system rule. Even AWS `--dry-run` waits for approval on
non-allowlisted operations. Read-only describe, S3 ls, STS get-caller-identity and
terraform or tofu plan remain allowed. The guard is a safety net, not a sandbox or API permission boundary.

## Keep awake and model retirement

A root LaunchDaemon `local.caffeinate` runs `/usr/bin/caffeinate -ims`, keeping the
system awake while the display may sleep. The host script also applies
`sudo pmset -c sleep 0 disksleep 0 womp 1`. Once Jan verifies the daemon, he can stop
the manual caffeinate in the Rex pane. No display assertion is installed.

Model deletion is gated by `~/.local/state/agents/model-wipe-approved`. Without it
the script does nothing and the Brewfile temporarily retains already installed
llama.cpp and osaurus, even though their package registry lines are retired. It never
reinstalls a retired model package. Creating the marker changes
the rendered script digest, so a subsequent apply performs the deletion. Never
create it until kubernetes confirms LiteLLM no longer routes to this box and Jan
approves the wipe separately.

The wipe boots out and removes `local.llama-swap` and `local.wired-limit`, removes
`~/models`, `~/MLXModels`, `~/.osaurus`, `~/comfyui`, `~/comfyui-data`, the comfyui
and hf venvs, `~/.config/m3pro` and `~/.cache/huggingface`, and uninstalls llama.cpp
and osaurus. Before changing anything it checks the entire deletion inventory,
rejects symlink targets and ancestors, and refuses paths outside the approved roots.
It fails closed on empty HOME and protects HOME itself, `~/Development`,
`~/.kube/config` and `~/.talos`. It leaves `local.node-exporter`. A reboot is still needed to return the
wired memory limit to the OS default, no reboot is automatic. `~/bc250-eval` is
preserved whole because it contains gaming and hardware documentation as well as
AI evaluation material. The gaming project will move it separately.

The M3 Pro model ids and sisyphus subagent placement are retired from central model
scope and instructions. Other legacy m3pro model definitions are reported in the
build handoff, not silently removed. Kubernetes owns LiteLLM routes and AI owns
mac-models retirement.

## Hourly backup

`local.sisyphus-backup` runs hourly and its independent watchdog every 15 minutes.
Both exit successfully with a clear disabled status until
`~/.config/sisyphus-backup/enabled` and a pinned known_hosts entry exist. Do not
create that marker before NAS provisioning. `sisyphus-backup status` reports disabled,
no recorded success or the latest success timestamp. A mere installed timer is not
backup protection.

Repository: `sftp:sisyphus-backup@192.168.69.15:/sisyphus/restic`, dataset
`Vault/Backups/sisyphus`. The private key is `~/.ssh/sisyphus-backup`. Pin the NAS
host key in `~/.config/sisyphus-backup/known_hosts` after independent verification.
`ai-sync` writes the password from `op://Work/sisyphus-backup/RESTIC_PASSWORD` to
`~/.config/restic/sisyphus.password`. Alerts use the existing Kubernetes Pushover
keys, cached in `~/.config/sisyphus-backup/pushover.env`. Neither is backed up.

Scope is `~/Work`, `~/.pi/agent/sessions`, `~/.local/share/agent-history` and
`~/.local/state/agents`. Not the dotfiles source, which is on GitHub. It includes
Git stores, worktrees, dirty and untracked content. Exclusions match aether's narrow
reproducible caches and runtime locks, with task runner locks excluded too. It
supports workspace `.backup-exclude` paths, never generic .env or lockfile excludes.
Keep 48 hourly, 30 daily, 12 weekly and 12 monthly snapshots, prune daily after 03:00,
check one percent weekly. Failures alert, and no success for two hours alerts at most
once every six hours. Logs are in `~/.local/state/sisyphus-backup`.

This is an online file copy, not an atomic workspace snapshot. Before trusting it,
run one backup, restore `~/Work/work/notes` into a temporary directory and diff it,
then inspect restored Git and dirty content. Use `mise exec -- restic` with the same
repo, password file and pinned SFTP options as the script. Do not substitute an
unpinned SSH connection during restore. Do not delete the laptop source before a
successful snapshot and restore drill.

## Deployment sequence

Nothing in this build deploys live changes. In order, after Jan reviews and publishes
this dotfiles change:

1. On aether, dotfiles asks kubernetes to retire all LiteLLM routes and fallbacks to
   sisyphus and create the dedicated sisyphus memini key without a home namespace.
   Ask ai to record mac-models retirement. Track the replies, do not infer completion.
2. Jan creates the Work-only 1Password service account, fills the Work GitHub token
   and backup password items, then in a sisyphus shell writes
   `~/.config/op/sisyphus-work.env` mode 0600 in a mode 0700 op directory. Keep the
   existing Kubernetes token in sisyphus.env. Do not put either token in dotfiles.
3. First apply requires Jan in a local sisyphus terminal for sudo and a logged-in
   GUI session for LaunchAgents. Jan fetches the published dotfiles, reviews
   `chezmoi diff` and runs `chezmoi apply`. Main may use
   `ssh sisyphus chezmoi update` for later platform updates, not other setup commands.
   The model wipe is still a no-op. Mise installs tools, backup and inbox SSH keys
   are generated, and backup remains disabled. Do not start or migrate Work yet.
4. Jan checks `sudo launchctl print system/local.caffeinate` and `pmset -g custom`.
   Once the daemon is active with the intended settings, stop the old manual
   caffeinate pane. No need to keep the display awake.
5. Jan supplies the work-inbox public key to dotfiles. Fill workInbox.publicKey in
   dotfiles, verify sourceAddress remains sisyphus's tailnet IP, publish and update
   aether. Verify the forced-command authorized_keys line, preserve all operator
   keys. Independently pin aether's host key on sisyphus. Do not grant a shell key.
6. After kubernetes confirms the new memini key exists, Jan runs `ai-sync` on
   sisyphus. Verify only work.env is generated there, its GH_TOKEN comes from Work,
   and the shared credential cache uses MEMINI_API_KEY_sisyphus. Inspect permissions,
   not values. A missing Work item must fail without replacing a good project env.
7. From Work once initialized, or via dotfiles with Jan relaying the public key first,
   ask bigmouth to provision Vault/Backups/sisyphus, the restricted SFTP user,
   authorized backup public key and NAS snapshots. The key handed over is
   `~/.ssh/sisyphus-backup.pub`, not work-inbox.pub. Jan verifies the NAS host key
   independently and pins it in sisyphus-backup/known_hosts. Only after the NAS reply
   create sisyphus-backup/enabled. Missing markers or known_hosts stay disabled.
8. After the explicit LiteLLM retirement reply and Jan's separate approval, Jan
   creates `~/.local/state/agents/model-wipe-approved` and applies again. Verify the
   model daemons and paths are gone, node-exporter remains, and arrange a reboot
   with Jan, including FileVault access. Check wired memory and free space afterward.
9. Separately migrate Work. Freeze laptop Work sessions, rsync to a staging tree,
   verify counts and git fsck for all 17 checkouts, then `agent work` initializes the
   empty workspace. Move the repos into direct children and use
   `agent-run --register work <name> <url>` for each existing checkout. Preserve dirty
   trees. Put old task folders and loose files in untracked `history/`, index them
   in notes/knowledge/history.md and checkpoint explicitly. Add history/ to the
   workspace .gitignore during migration, it is not an initialization seed.
10. Copy the 18 old session files into agent-history/work/sessions with their source
    folder names. Verify the fixed work namespace and `/memini:status` with no home
    leg. Test a request to dotfiles and its pulled reply. Configure WBD SSO and test one
    temporary SAML profile with `work-creds` from hermes. Supply AWS inventory, run
    k8s-sync in the Work tab with Jan's approval for the target operations.
11. Run `sisyphus-backup`, verify `status`, restore and diff notes and verify Git and
    dirty data. Only then, with Jan's yes, delete the laptop's migrated Work copies
    and old Work session folders, retaining empty Work as intake. Do not use
    work-wipe for migration cleanup, it deletes work credentials too.
12. Main can run `agent ls` and `agent restart all` on sisyphus. The laptop's
    `agent ls` shows both hosts and `agent work` dispatches to sisyphus. Give work its
    first brief in its Rex tab. Start with one project and bounded tasks, measure
    memory before considering a higher cap.

## Daily use and permanent wipe

On hermes, `agent work`, `agent task new work TICKET-123 "brief"`, `agent task ls`
and `agent restart all` dispatch to the registry hosts. Select the sisyphus connection
in Rex. Its own program title stays, Rex tab indicators show activity. No title
spinner package is needed. `ai-sync` refreshes keys, `sisyphus-backup status` checks
backup state and `work-creds <profile>` renews one temporary SAML profile.

For permanent deletion, read the mandatory `wipe.md` standard first. Stop Work agents
and boot out both backup LaunchAgents before running a reviewed `work-wipe --dry-run`
and, only with Jan's separate approval, `work-wipe --really` on both machines. The
inventory includes credentials and all non-homelab kube files, preserves
`~/Development`, `~/.talos`, homelab kube config and personal Pi sessions, and deletes
sisyphus's backup marker and keys. Do not stop at host deletion: remove Work memini
namespaces with the admin key, retire the sisyphus memini key through kubernetes,
have bigmouth and Jan destroy the NAS dataset and address snapshots and replicas,
revoke the Work service account and review the Work vault. Revoke the aether inbox
key and remove its queued Work replies. Verify local and off-host deletion explicitly.
