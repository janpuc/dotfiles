# Pi runbook

Source: `home/dot_local/bin/executable_pi`, `home/dot_pi/`. Edit chezmoi source, not live files.
Pi is managed on the Mac only. New sessions default to `claude-bridge/claude-opus-5-5`, medium
thinking. `Ctrl+P` switches the main driver between Opus and `openai/gpt-6.1-sol` (pinned in
`enabledModels`); `/model` and `/thinking` change deliberate selections; resumed sessions retain theirs.
Provider failures are reported, never used to silently replace the main collaborator.

Owned code is kept small on purpose: the profile extension (usage view, commit-trailer guard,
memory scope, notifications, title), the quiet memory adapter, the launcher and the settings merge.
Everything else is an upstream package pinned in `home/dot_pi/private_agent/modify_settings.json.tmpl`:
`pi-claude-bridge`, `pi-memini`, `pi-web-access`, `pi-subagent-manager`. Update pins deliberately,
after reading the changelog.

## Launch and memory scope

- `pi` launches from the current directory; `pi -c`, `pi -r` and `pi --session <file>` resume.
- `pi-profile` shows directories, account readiness and the memini handshake.
- Projects under `~/Work` (including related symlinks/worktrees) use `work/*` memory; other projects
  use personal memory. A session stamped with one scope cannot continue under the other.
- `PI_MEMINI=off pi ...` disables memory; `/profile` shows scope diagnostics.

## Accounts

- Claude: `pi-profile login`; isolated `~/.pi/agent/claude`, not native `~/.claude`.
- ChatGPT subscription: `/login openai` (native OpenAI provider).
- Go, MiniMax, memini and local gateway: `ai-sync` refreshes the private credential cache.
- `pi-profile auth` checks readiness. No credentials belong in this repository.

## Usage view

`/usage`, `/usage refresh`, the bars below the editor and `usage_status` show Claude, ChatGPT,
OpenCode Go and MiniMax, refreshed every five minutes. Failed refreshes keep the last good windows
and mark them stale; unknown usage is not proof of available quota. Usage informs which model a
delegated agent gets; it never changes the main driver.

## Subagents (pi-subagent-manager)

The main model delegates with `agent_spawn` and friends; `/agents` opens settings, types and the tree.
Configuration lives in `~/.pi/agent/subagent-manager/`: `settings.json` (at most two agents at once,
one level deep, least-privilege tools, braille loaders) and settings-only overrides of the bundled
types in `agents/*.yml`:

| Type | Models | Tools |
|---|---|---|
| `tasker`, `researcher` | DeepSeek V4.1 Flash (Go), then MiniMax M3 | read-only; researcher adds web search/fetch |
| `coder` | GPT-6.1 Sol | read, edit, write, bash |
| `reviewer`, `writer` | GPT-6.1 Sol | read-only |
| `architect` | Fable 5.1 (Claude quota) | read-only |

`/name` paths start fresh agents without this conversation; `/root/name` forks it. Agents run inside
this Pi process and share the checkout; their tools do not pass through the main session's hooks.
`←` on the prompt opens the agent browser while agents run; the widget sits above the editor.
See the package's `docs/tools-and-ui.md` for keys and commands.

## Approvals

There is no enforcement layer. The model-facing instructions (`context/AGENTS.md`) require asking
Jan in chat, with commands and consequences, before pushing, publishing, deploying,
`chezmoi apply/update`, cluster or system changes, sending data off the machine, deleting work or
reading secrets. Agents report such steps back instead of running them.

## Memory

Memini loads once through `extensions/memory`. Automatic recall and briefings stay in model context
and persisted messages, but routine rows are hidden in the UI; explicit tools, `/memini:status` and
real failures stay visible. Load failures mark memory degraded.

## Prompt cache (Opus through the bridge)

The bridge replays the whole conversation, rewriting Opus's prompt cache, after an Esc interrupt,
`/reload`, resume or fork, a return to Opus after Sol answered in the main session, compaction and
SDK errors. In long Opus sessions steer instead of interrupting, start a new session after deploying
instead of reloading, and hand Sol work to an agent instead of switching the driver.

## Limits

This is **not a sandbox**: Pi and its agents run as your user. Commits/PRs must never credit an AI
model; the profile hook strips or refuses AI trailers. The terminal title shows a spinning `⠋` while
the agent works and `✓ <project>` when settled; completion notifications remain.

BC250 models are native `litellm/bc250-local/qwen3.6-35b-a3b` and `litellm/bc250/qwen3.6-35b-a3b`
(128K). Use them only when the machine is available for it. Local-only fails when the machine is
unavailable; the gateway-backed entry may answer via MiniMax. Verify generated citations.

## Maintenance

- Run `tests/pi/run.sh --typecheck` and `git diff --check` before handoff.
- Tests use temporary homes and an offline gateway; they do not certify live provider quality.
- Applying, publishing or deploying needs Jan's explicit yes; source changes do not uninstall
  packages or erase live state.
- `/reload` reloads extensions, not packages or saved model selections.
