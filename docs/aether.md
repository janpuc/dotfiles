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
| `home/.system/pi-pocket*` (installed by `20-linux-pi-pocket`) | [Pi Pocket](https://github.com/TannerMidd/pi-pocket) at a pinned release, run by the `pocket` user (no sudo, sees only its own home) as the `pi-pocket` system service on 127.0.0.1:8787; `tailscale serve` publishes it at `https://aether.<tailnet>.ts.net` on the tailnet only. At home the same URL works without Tailscale: a UniFi DNS record (`aether.tail17d532.ts.net` → aether's tailnet address, 100.108.252.49) and bob, the router on the tailnet, carry it. Node comes from pocket's own mise config. `pi-pocket-extensions/memini.ts` gives it memory in memini namespace `homelab/assistant` (home `personal/jan`): a briefing per conversation, recall on each message, and `memory_recall`/`memory_remember` tools; test it with `node --test` on its `memini.test.ts`. `approvals.ts` asks Jan in the app (push notification) before a bash command changes a shared system: git push, GitHub writes, cluster, Flux, Talos or Helm changes, chezmoi apply, Home Assistant service calls. `web.ts` gives it `web_search` (the home SearXNG at search.janpuc.com) and `web_fetch` (pages as text, with a FlareSolverr fallback). `pi-pocket-skills/` holds Pi skills for the cluster (read-only `view` access, Alertmanager and Prometheus over HTTPS), Home Assistant (`$HA_URL`, `$HA_TOKEN`) and GitHub (`gh`, signed in with the App's installation token). pocket's mise config adds gh, kubectl, flux and jq. `pi-pocket-gh-token` (a systemd timer, as `pocket`, every half hour) mints an installation token of the agent's own GitHub App, janpuc-agent (only home-ops, dotfiles and BC250, no admin or workflow rights; key from op://Kubernetes/janpuc-agent), and writes it into gh's own config for `pocket`, because a running service cannot see new environment values; git over HTTPS reads it through the `mise exec -- gh auth git-credential` helper. For dev work pocket commits as `janpuc-agent[bot]` (never as `bot-atlas[bot]`, the Renovate and kritika App, or Renovate takes the branch for its own), signed locally with its own key (`~pocket/.ssh/signing`, on GitHub as "pi-pocket (aether)"), but publishes only through `agent-push` for GitHub-verified App commits (see Step 1 below); home-ops, dotfiles and BC250 are cloned into `~pocket/work/` and trusted by mise, and new sessions start in `~pocket/scratch` |

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

## PR shepherd — Step 1

The **PRs** session uses `pr-shepherd/SKILL.md`. `pr-lane <N> [--json]` and
`pr-lane --all [--json]` read home-ops from GitHub and konflate without caching.
Every result includes the head SHA, lane, fired rules and supporting facts.
It reads paginated files (including old rename paths), head-specific statuses
and check runs, and bot-atlas' marked kritika comment. The comment's last
reviewed commit must match the head; its confidence, risk and findings must
parse. Severity counts may wrap across lines, but must be parseable and sum
to the findings total; missing counts for positive findings mean **wait**, not
zero P1. Explicit “No findings” means zero. Konflate's list and rendered diff
must both be ready for that head. Rendered CSS is not included in the output.

- **wait** takes priority: draft, pending/missing/stale/unparseable evidence.
  C reasons remain visible even when waiting. Explicit null namespaces mean
  empty only for a zero-resource impact; this normalization is reported.
- **C**: non-Renovate author (including Jan and the agent), Talos/Kubernetes
  groups, protected paths/namespaces, CRDs, blocking/render failures, high risk,
  any P1, confidence below 3, unsuccessful kritika, or failed/cancelled/timed-out/
  action-required CI. Kritika `error` is C, “review incomplete”, not wait.
  SKIPPED and NEUTRAL checks are acceptable. Major `.renovaterc.json5` and
  root `.mise*` changes (including `.mise/`) are C. Never merge C as the agent
  or ask for merge approval: send a one-screen brief plus a **`Jan:`** line.
  A later phase owns Talos/Kubernetes groups.
- **A**: digest/patch, routine render without caution, confidence at least 4,
  low risk and no P1, with no wait/C rule. Review the evidence, then ask Jan.
- **B**: everything else that is not wait/C. Review the diff, kritika, konflate
  and upstream release notes; repair real findings, wait for the new head's
  evidence, and classify again before asking Jan. Two PRs at a time, oldest first.

For both A and B, the agent merges with the exact fresh `pr-lane` head:

```sh
gh pr merge <N> -R janpuc/home-ops --squash --match-head-commit <sha-pr-lane-reported>
```

**Every merge asks Jan on his phone, with one Allow tap.** There is no lane
exception in `approvals.ts`. Pinning the head makes GitHub reject a merge if
it changed after review. Reclassify and review before asking again; never use
admin bypass or auto merge. Shared writes, including **`agent-push`**, also ask.
Dry-run exemptions apply only to simple bare invocations, never shell chains,
substitutions, comments or quoted payloads. Rules check both original and
quote/backslash-stripped commands. This guard remains a mistake detector,
not a shell sandbox or a security boundary: pocket is untrusted and still
holds a merge-capable token. Step 1 preserves today's human-approval workflow;
it does not claim to prevent a malicious pocket process from using that token.

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

### Merge runner deferred to Step 2

The setup installs only `agent-push` and `pr-lane` into `/usr/local/sbin`.
It does **not** install `pr-lane-merge`, its service or its timer. On re-run it
disables/stops any earlier draft timer, stops the service, and removes those
units, the timer's enable symlink and the installed runner. The retained runner,
units and tests are drafts, not approved for deployment. Do not enable them or
use the old pocket-owned opt-in file. Step 2 will install a merge broker under
a **separate account** and add a **GitHub ruleset**; nothing running as pocket
can authorize automatic merges. Those security controls are not part of Step 1.

### Apply and verify (operator steps, not performed while preparing changes)

After review and separate approval to transfer the uncommitted source changes
to aether's chezmoi source, an operator can run:

```sh
chezmoi diff
chezmoi apply
sudo systemctl is-enabled pr-lane-merge.timer
sudo systemctl is-active pr-lane-merge.timer
sudo -u pocket -H env PATH=/home/pocket/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin pr-lane --all --json
```

The timer must be absent/disabled and inactive (the two `is-*` checks should
return nonzero). Verify the runner and its unit files are absent. Normal setup
restarts Pi Pocket to load the changed approvals and installs the skills.
A merge still needs Jan's phone approval regardless of the reported lane.

Local checks, with Node >=22.19, gh, chezmoi and shellcheck:

```sh
node --test home/.system/*.test.cjs home/.system/pi-pocket-extensions/*.test.ts
chezmoi --source "$PWD/home" --override-data '{"chezmoi":{"os":"linux"}}' execute-template < home/.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl > /tmp/pi-pocket-setup.sh
shellcheck /tmp/pi-pocket-setup.sh
sh -n /tmp/pi-pocket-setup.sh
git diff --check
```

Render only: do not execute the setup during validation. Tests use local bare
repos and fake GitHub/system commands, not shared-system writes. They cover
dry-run/quoting evasions, per-call merge approval, multiline/incomplete severity
counts and stale timer cleanup. Retained merge-runner tests are not deployment
approval. A live `pr-lane --all --json` needs only read access; keep tokens out
of logs.
