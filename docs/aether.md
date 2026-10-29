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
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | Linux: give the server's gh and Pi Pocket their keys from 1Password only; no AI keys fetched or cached |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, system helpers, terminfo and mise setup |
| `home/.system/aether-hosts-sync*` (installed by `05-linux-system`) | hourly: derive internal DNS names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/xterm-ghostty.terminfo` (`06-linux-terminfo`) | Ghostty terminfo in `~/.terminfo`, absent from Ubuntu's ncurses |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |
| `home/.system/pi-pocket*` (installed by `20-linux-pi-pocket`) | [Pi Pocket](https://github.com/TannerMidd/pi-pocket) at a pinned release, run by the `pocket` user (no sudo, sees only its own home) as the `pi-pocket` system service on 127.0.0.1:8787; `tailscale serve` publishes it at `https://aether.<tailnet>.ts.net` on the tailnet only. At home the same URL works without Tailscale: a UniFi DNS record (`aether.tail17d532.ts.net` → aether's tailnet address, 100.108.252.49) and bob, the router on the tailnet, carry it. Node comes from pocket's own mise config. `pi-pocket-extensions/memini.ts` gives it memory in memini namespace `homelab/assistant` (home `personal/jan`): a briefing per conversation, recall on each message, and `memory_recall`/`memory_remember` tools; test it with `node --test` on its `memini.test.ts`. `approvals.ts` asks Jan in the app (push notification) before a bash command changes a shared system: git push, GitHub writes, cluster, Flux, Talos or Helm changes, chezmoi apply, Home Assistant service calls. `web.ts` gives it `web_search` (the home SearXNG at search.janpuc.com) and `web_fetch` (pages as text, with a FlareSolverr fallback). `pi-pocket-skills/` holds Pi skills for the cluster (read-only `view` access, Alertmanager and Prometheus over HTTPS), Home Assistant (`$HA_URL`, `$HA_TOKEN`) and GitHub (`gh`, signed in with the App's installation token). pocket's mise config adds gh, kubectl, flux and jq. `pi-pocket-gh-token` (a systemd timer, as `pocket`, every half hour) mints an installation token of the agent's own GitHub App, janpuc-agent (only home-ops, dotfiles and BC250, no admin or workflow rights; key from op://Kubernetes/janpuc-agent), and writes it into gh's own config for `pocket`, because a running service cannot see new environment values; git over HTTPS reads it through the `mise exec -- gh auth git-credential` helper. For dev work pocket commits as `janpuc-agent[bot]` (never as `bot-atlas[bot]`, the Renovate and kritika App, or Renovate takes the branch for its own), signed locally with its own key (`~pocket/.ssh/signing`, on GitHub as "pi-pocket (aether)"), but publishes only through `agent-push` for GitHub-verified App commits (see the PR shepherd below); home-ops, dotfiles and BC250 are cloned into `~pocket/work/` and trusted by mise, and new sessions start in `~pocket/scratch` |

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

Run `fish -c ai-sync` manually when GitHub authentication needs refreshing. Linux no longer
fetches or sources `~/.local/state/ai/credentials.fish`.

## Upgrading Pi Pocket

The release is pinned in `home/.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl`
(`version` and `commit`, checked against the tag). `chezmoi apply` does the upgrade in this
order:

1. stop the service and archive `/home/pocket/.pi-pocket` into
   `/home/pocket/archive/pi-pocket-<old version>-<date>.tar.gz` (the service must be stopped:
   the archive holds a live SQLite database),
2. check out the pinned tag and run `npm ci`,
3. install the drop-ins, the service unit and the token helper, turn on the extensions in
   `config.json`,
4. start the service again.

The archive matters: Pi Durable 1.4 (Pi Pocket 0.21.0 and newer) rewrites `pocket.sqlite` the
first time it opens it, and 0.20.0 and earlier cannot read the result.

### Rolling back

1. `sudo systemctl stop pi-pocket.service`
2. move the current `/home/pocket/.pi-pocket` aside and unpack the archive over it:
   `sudo -u pocket tar -xzf /home/pocket/archive/pi-pocket-0.11-<date>.tar.gz -C /home/pocket`
3. check out the old tag in `/home/pocket/pi-pocket` and `npm ci` again,
4. put the old drop-ins back (they declare `pocketApi = 2`, which 0.11.0 does not load),
5. `sudo systemctl start pi-pocket.service`

Rolling back the dotfiles themselves (`git revert` and `chezmoi apply`) does steps 3 to 5 in
one go.

## Retirement and verification

Changing the allowlist does **not** delete previously deployed targets or uninstall tools.
The reviewed server cleanup must explicitly remove retired state, launchers, user services,
optional detach sessions and unused packages before updating from the pushed source.
Do not remove the GitHub authentication, signing key, system helpers or shell basics above.
Read-only checks include `chezmoi managed`, `mise ls`, `gh auth status`,
`systemctl status aether-hosts-sync.timer aether-keepalive.service` and
`systemctl --user list-unit-files`.

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
bot-authored and edit-checked. The table's `Update` column is read per row and
the most severe type wins (major > minor > patch > digest); a missing,
malformed or unknown value is **wait**. Repository labels can be renamed without
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
makes the decision. Every other write still asks, including `agent-push`,
direct `gh pr merge`, and API merges. Chaining a write onto a request does not
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
  overrides exist for testing; installed units never use overrides. Only root
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
on the half hour. Both run as pr-broker under the same `flock`. For requests,
the broker ignores the submitter's claims, freshly classifies the numeric PR,
and merges only **A or B with the exact requested head**. Lane A processing
selects oldest first, at most five, reclassifies before each merge and stops
at the first refusal/error. Both use only:
`gh pr merge N -R janpuc/home-ops --squash --match-head-commit <sha>`.

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

```sh
node --test home/.system/*.test.cjs home/.system/pi-pocket-extensions/*.test.ts
chezmoi --source "$PWD/home" --override-data '{"chezmoi":{"os":"linux"}}' execute-template < home/.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl > /tmp/pi-pocket-setup.sh
shellcheck /tmp/pi-pocket-setup.sh home/.system/pr-broker-runtime.sh
sh -n /tmp/pi-pocket-setup.sh
sh -n home/.system/pr-broker-runtime.sh
git diff --check
```

Render only: do not execute the setup during validation. Tests use local bare
repos, fake gh/pr-lane paths and synthetic credentials/switch ownership, not
shared-system writes. They cover validation, head/lane mismatch, dry-run,
shared quota, malformed inputs, symlinks/FIFOs/hardlinks/races, flood bounds,
result permissions, token scope, five/run and stop-first-failure semantics,
approvals and installer/runtime invariants. Verify units with
`systemd-analyze verify` on Linux (passed on aether's systemd 255 with only
unrelated existing executable-bit warnings on Oracle monitoring units). This
checks unit syntax, not ExecStart arguments behind flock. Actual App
authentication and hardened runtime need the operator dry-run checks above.
