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
| `home/.system/pi-pocket*` (installed by `20-linux-pi-pocket`) | [Pi Pocket](https://github.com/TannerMidd/pi-pocket) at a pinned release, run by the `pocket` user (no sudo, sees only its own home) as the `pi-pocket` system service on 127.0.0.1:8787; `tailscale serve` publishes it at `https://aether.<tailnet>.ts.net` on the tailnet only. At home the same URL works without Tailscale: a UniFi DNS record (`aether.tail17d532.ts.net` → aether's tailnet address, 100.108.252.49) and bob, the router on the tailnet, carry it. Node comes from pocket's own mise config. `pi-pocket-extensions/memini.ts` gives it memory in memini namespace `homelab/assistant` (home `personal/jan`): a briefing per conversation, recall on each message, and `memory_recall`/`memory_remember` tools; test it with `node --test` on its `memini.test.ts`. `approvals.ts` asks Jan in the app (push notification) before a bash command changes a shared system: git push, GitHub writes, cluster, Flux, Talos or Helm changes, chezmoi apply, Home Assistant service calls. `web.ts` gives it `web_search` (the home SearXNG at search.janpuc.com) and `web_fetch` (pages as text, with a FlareSolverr fallback). `pi-pocket-skills/` holds Pi skills for the cluster (read-only `view` access, Alertmanager and Prometheus over HTTPS), Home Assistant (`$HA_URL`, `$HA_TOKEN`) and GitHub (`gh`, signed in with the App's installation token). pocket's mise config adds gh, kubectl, flux and jq. `pi-pocket-gh-token` (a systemd timer, as `pocket`, every half hour) mints a GitHub App installation token for Jan's account (only home-ops, dotfiles and BC250, and no workflow rights) and writes it into gh's own config for `pocket`, because a running service cannot see new environment values; `gh auth setup-git` points git over HTTPS at it. For dev work pocket commits as janpuc-agent <agent@janpuc.com> (never as `bot-atlas[bot]`, or Renovate takes the branch for its own), signed with its own key (`~pocket/.ssh/signing`, on GitHub as "pi-pocket (aether)"); home-ops, dotfiles and BC250 are cloned into `~pocket/work/` and trusted by mise, and new sessions start in `~pocket/scratch` |

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
  `github-app-client-id`: the GitHub App "github-bot" key and client id, written by `ai-sync`
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
