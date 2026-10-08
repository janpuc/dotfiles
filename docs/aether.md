# aether (Linux server): Pi and T3 Code

The Ubuntu server runs Pi and the T3 Code server, plus the internal DNS sync, and nothing else from
this repo. T3 serves the
desktop and phone apps over Tailscale; its `pi` provider runs the same `pi` (the launcher in
`~/.local/bin`, Personal profile) that you run in a terminal, so both see the same sessions.

What a Linux machine manages is an allowlist in `home/.chezmoiignore`; add a path there to share
another file. Work is never deployed (no Work profile, AWS or omp), and the launcher refuses Work
sessions there.

| | |
|---|---|
| `bootstrap-linux.sh` | mise, then `chezmoi init --apply` |
| `home/.chezmoidata/packages.yaml` → `linux.apt` | the few apt packages (zsh, fish, git, curl, dtach, libatomic1, python3-yaml) |
| `home/dot_config/mise/config.toml` | node, Pi, T3, `op`, Codex, chezmoi, gh, jq |
| `home/dot_config/systemd/user/t3code.service` | T3 on the tailnet address, port 3773 |
| `home/dot_t3/userdata/create_settings.json.tmpl` | seeds one `pi` provider instance, only if T3 has no settings yet |
| `home/dot_config/git/config.tmpl` | Linux: commits signed with the server's `~/.ssh/id_ed25519` (GitHub signing key `aether-sign`); no `bat`/`difft` |
| `home/.system/aether-hosts-sync*` (installed by the `05-linux-system` script) | hourly: internal `*.janpuc.com` names from public home-ops into `/etc/hosts`, because the UniFi gateway does not answer DNS from the tailnet |
| `home/.system/xterm-ghostty.terminfo` (`06-linux-terminfo` script) | Ghostty's terminfo in `~/.terminfo`; Ubuntu's ncurses lacks it |
| `home/.system/aether-keepalive*` | holds 25% of RAM (no CPU), so Oracle never sees the instance as idle: it reclaims only when CPU p95, network and memory are all under 20% for 7 days |
| `home/dot_config/fish/config.fish.tmpl` | the laptop's fish setup with mise; at login it says when Pi sessions are still running |
| `dtach` (apt) + `pi-attach` | interactive Pi survives a dropped SSH connection; see `home/dot_pi/shared/README.md`, Sessions |
| `unii` + `home/private_dot_optchat/` | the one chat that never ends (pi-optchat) lives here; the laptop's `unii` opens it over SSH; see `home/dot_pi/shared/README.md`, Unii |

## What lives on the server only

Never in this (public) repo:

- `~/.config/op/aether.env` (0600): `OP_SERVICE_ACCOUNT_TOKEN=…`, a read-only 1Password service account for
  the `Kubernetes` vault. Everything else comes from it.
- `~/.ssh/id_ed25519`: the server's key; signs commits and is its GitHub signing key.
- What `ai-sync` writes: `~/.local/state/ai/credentials.fish` and gh's token in `~/.config/gh/hosts.yml`.
- Logins: `~/.pi/agent/auth.json`, `~/.pi/agent/claude` (Claude bridge), T3's `~/.t3/userdata/secrets`.

## Steps that stay manual

1. `fish -c ai-sync` (with `~/.config/op/aether.env` in place): caches the memini, LiteLLM, OpenCode,
   MiniMax and OpenAI keys and logs gh in. The Pi launcher reads the cache itself, so T3 needs no
   credentials of its own.
2. `pi-profile login`: Claude subscription login for the bridge. In Pi, `/login openai` for ChatGPT.
   Providers without a login are skipped by the router.
   `codex login --device-auth`: the Pi footer reads ChatGPT usage through the Codex CLI's own login.
3. Pair the T3 apps with the server (`t3 --help` for the pairing command).

## Left out on purpose

Codex/OpenCode/Claude Code as separate T3 providers, and anything from the old aether repo.
