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
| `home/dot_config/fish/functions/ai-sync.fish.tmpl` | Linux: authenticate gh from 1Password only; no AI keys fetched or cached |
| `home/dot_config/git/` | gh credential helper, bat pager, difftastic diff, SSH commit signing |
| `home/dot_config/{starship.toml,atuin,bat,eza}` and `home/dot_editorconfig` | prompt, history, file display and editing basics |
| `home/.chezmoiscripts/*-linux-*.sh.tmpl` | apt, system helpers, terminfo and mise setup |
| `home/.system/aether-hosts-sync*` (installed by `05-linux-system`) | hourly: derive internal DNS names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/xterm-ghostty.terminfo` (`06-linux-terminfo`) | Ghostty terminfo in `~/.terminfo`, absent from Ubuntu's ncurses |
| `home/.system/aether-keepalive*` (installed by `05-linux-system`) | hold 25% of RAM without CPU load to avoid Oracle's idle-instance reclamation criteria |
| `home/.system/pi-pocket*` (installed by `20-linux-pi-pocket`) | [Pi Pocket](https://github.com/TannerMidd/pi-pocket) at a pinned release, run by the `pocket` user (no sudo, sees only its own home) as the `pi-pocket` system service on 127.0.0.1:8787; `tailscale serve` publishes it at `https://aether.<tailnet>.ts.net` on the tailnet only. At home the same URL works without Tailscale: a UniFi DNS record (`aether.tail17d532.ts.net` → aether's tailnet address, 100.108.252.49) and bob, the router on the tailnet, carry it. Node comes from pocket's own mise config. `pi-pocket-extensions/memini.ts` gives it memory in memini namespace `homelab/assistant` (home `personal/jan`): a briefing per conversation, recall on each message, and `memory_recall`/`memory_remember` tools; test it with `node --test` on its `memini.test.ts` |

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
- `/home/pocket/.config/pi-pocket/secrets.env` (0600, owned by pocket): Pi Pocket's model
  keys (OpenCode Go, MiniMax, and the Claude API key with its monthly plan credit) and its
  memini key, written
  by `ai-sync` from 1Password and loaded into the service by pocket's mise
  config. Run `fish -c ai-sync` again after a key rotation; it restarts the service.
- `/home/pocket/.pi-pocket/`: Pi Pocket's database, push keys and sign-ins. Print the owner
  sign-in link from the Mac with
  `aether sudo cat /home/pocket/.pi-pocket/config.json | jq -r '"https://aether.tail17d532.ts.net/login?token=" + (.ownerToken|@uri)'`.

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
