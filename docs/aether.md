# aether (Linux server): Pi and T3 Code

The Ubuntu server runs Pi and the T3 Code server and nothing else from this repo. T3 serves the
desktop and phone apps over Tailscale; its `pi` provider runs the same `pi` (the launcher in
`~/.local/bin`, Personal profile) that you run in a terminal, so both see the same sessions.

What a Linux machine manages is an allowlist in `home/.chezmoiignore`; add a path there to share
another file. Work is never deployed (no Work profile, AWS or omp), and the launcher refuses Work
sessions there.

| | |
|---|---|
| `bootstrap-linux.sh` | mise, then `chezmoi init --apply` |
| `home/.chezmoidata/packages.yaml` → `linux.apt` | the few apt packages (zsh, fish, git, curl) |
| `home/dot_config/mise/config.toml` | node, Pi, T3, `op`, chezmoi, gh, jq |
| `home/dot_config/systemd/user/t3code.service` | T3 on the tailnet address, port 3773 |
| `home/dot_t3/userdata/create_settings.json.tmpl` | seeds one `pi` provider instance, only if T3 has no settings yet |
| `home/dot_config/git/config.tmpl` | Linux: no commit signing, no `bat`/`difft` |

## Steps that stay manual

1. `OP_SERVICE_ACCOUNT_TOKEN=… fish -c ai-sync`: caches the memini, LiteLLM, OpenCode, MiniMax and OpenAI
   keys. The Pi launcher reads the cache itself, so T3 needs no credentials of its own.
2. `pi-profile login`: Claude subscription login for the bridge. In Pi, `/login openai` for ChatGPT.
   Providers without a login are skipped by the router.
3. `gh auth login`: git's credential helper for GitHub.
4. Pair the T3 apps with the server (`t3 --help` for the pairing command).

## Left out on purpose

Commit signing (no key on the server yet), the fish config and memini namespace hook (the launcher's
own handshake picks the namespace), Codex/OpenCode/Claude Code as separate T3 providers, ChatGPT usage
in the Pi footer (needs the Codex CLI), and anything from the old aether repo.
