---
name: chezmoi-change
description: Change, adopt or audit Jan's chezmoi-managed configuration (janpuc/dotfiles) on the laptop or the aether server. Use for any edit to dotfiles, Pi config, fish, git, mise tools, packages, systemd units or setup scripts, and when a managed file drifted.
---

# Changing the dotfiles

One public chezmoi repo, `janpuc/dotfiles`, configures both machines: the macOS laptop and the
`aether` Ubuntu server. Source: `~/.local/share/chezmoi`, with `.chezmoiroot` = `home/`.

## Rules

- Edit the **source** under `~/.local/share/chezmoi/home/`, never the deployed file in `$HOME`;
  a live edit is undone by the next apply. `chezmoi source-path <target>` finds the source.
- The repo is **public**. No secret, token, API key, private address or Work detail ever goes in
  it. Secrets live only on each machine: `ai-sync` caches AI keys in
  `~/.local/state/ai/credentials.fish` (0600) from 1Password; on aether the 1Password service
  account token is `~/.config/op/aether.env`. Config refers to them by env var or `op://` path.
- **Work never reaches aether.** Read `home/.chezmoiignore` before adding a file: Linux takes an
  allowlist, so a new file is laptop-only until it is listed there.
- Tools come from Homebrew on macOS (`home/.chezmoidata/packages.yaml` → `darwin`) and from mise
  on aether (`home/dot_config/mise/config.toml`; apt only for what mise cannot provide,
  `packages.linux.apt`). Never install anything by hand on aether.
- One stage at a time: make the change, show what it does, verify, report, then wait.
- `chezmoi apply`/`update` and `git push` need Jan's approval (the Personal tool policy asks).

## Steps

1. Look before editing: `chezmoi status`, then `chezmoi diff` for the targets involved. A target
   that differs from its source has drifted: find out whether the live change should be kept
   (`chezmoi re-add <target>`, only for non-template targets) or overwritten.
2. Edit the source. For files that differ between machines, use a `.tmpl` with
   `{{ if eq .chezmoi.os "darwin" }}` blocks, as `config.fish.tmpl` and `git/config.tmpl` do.
3. **Prove the other machine is unaffected.** A laptop-only change must not change what Linux
   renders, and the reverse. Compare renders before and after:
   ```sh
   chezmoi execute-template < home/<file>.tmpl                                                 # this OS
   chezmoi execute-template --override-data '{"chezmoi":{"os":"linux"}}' < home/<file>.tmpl   # aether
   chezmoi managed | sort   # compare the managed set before and after the edit
   ```
4. Pi changes (`home/dot_pi`, `home/dot_local/bin/executable_pi`, `tests/pi`): read
   `home/dot_pi/shared/README.md`, then run `tests/pi/run.sh --typecheck`. All suites must pass.
5. Show `chezmoi diff` and wait for Jan. After approval: `chezmoi apply` on the laptop; on aether,
   commit, push, then `chezmoi update` there. Open Pi sessions need `/reload`.
6. Commit as Jan's own work: conventional message, no AI attribution, signed (the machine's git
   config does it). Check `git status` is clean afterwards.

## Gotchas

- `run_onchange_*` scripts re-run when the hashes in their comments change; include every file
  the script depends on, as the existing scripts do.
- On macOS `chezmoi apply` can hang in the Homebrew package script; `chezmoi apply --exclude scripts`
  applies only files.
- aether's checkout tracks `origin/main`, so `chezmoi update` there pulls and applies.
