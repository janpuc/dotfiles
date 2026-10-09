# aether (Ubuntu server): shell basics and infrastructure helpers

Aether keeps a familiar remote shell and two infrastructure helpers: internal DNS sync and
keepalive. AI runtimes are retired from the server; laptop configuration stays on the Mac.
An allowlist in `home/.chezmoiignore` makes that boundary explicit: new laptop files do not
reach Linux unless deliberately added there.

## What Linux manages

| Source | Purpose |
|---|---|
| `home/.chezmoidata/packages.yaml` → `linux.apt` | ca-certificates, curl, fish, git, python3-yaml and zsh |
| `home/dot_config/mise/config.toml` | chezmoi, gh, 1Password CLI, starship, atuin, zoxide, eza, bat and difftastic |
| `home/dot_config/fish/config.fish.tmpl` and fish theme | fish with mise activation and the common shell tools; no AI credential cache or memory hook on Linux |
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | Linux: authenticate gh from 1Password only; no AI keys fetched or cached |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, system helpers, terminfo and mise setup |
| `home/.system/aether-hosts-sync*` (installed by `05-linux-system`) | hourly: derive internal DNS names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/xterm-ghostty.terminfo` (`06-linux-terminfo`) | Ghostty terminfo in `~/.terminfo`, absent from Ubuntu's ncurses |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |

No user-level systemd services, AI dot-directories or `~/.local/bin` launchers are allowlisted.
The infrastructure units above are system services, installed separately by the Linux script.
`bootstrap-linux.sh` remains the initial mise/chezmoi bootstrap, not a retirement mechanism.

## What lives on the server only

Never in this public repository:

- `~/.config/op/aether.env` (0600): the read-only 1Password service-account token used by
  `ai-sync` to obtain the server's GitHub token. It is still needed for this GitHub-only workflow.
- `~/.config/gh/hosts.yml` (0600): gh's own stored authentication, used by Git's credential helper.
- `~/.ssh/id_ed25519`: the server's private SSH signing key. Git uses the corresponding
  `~/.ssh/id_ed25519.pub`, registered on GitHub as `aether-sign`.

Run `fish -c ai-sync` manually when GitHub authentication needs refreshing. Linux no longer
fetches or sources `~/.local/state/ai/credentials.fish`.

## Retirement and verification

Changing the allowlist does **not** delete previously deployed targets or uninstall tools.
The reviewed server cleanup must explicitly remove retired state, launchers, user services,
optional detach sessions and unused packages before updating from the pushed source.
Do not remove the GitHub authentication, signing key, system helpers or shell basics above.
Read-only checks include `chezmoi managed`, `mise ls`, `gh auth status`,
`systemctl status aether-hosts-sync.timer aether-keepalive.service` and
`systemctl --user list-unit-files`.
