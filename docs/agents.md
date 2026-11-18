# Project agents on aether: user guide

aether is Jan's personal dev machine. Every project there has one long-lived Pi agent that
Jan talks to through Rex. This page is how to use it. The design behind it is in
[projects](projects.md), the machine itself in [aether](aether.md).

## The shape of it

- A project is a folder `~/Development/<project>` on aether: a local git repo (the workspace)
  with the project's code repos inside as git submodules, plus notes, plans and scripts.
- Each project has one Rex session named after it, with two tabs: `pi` (the agent) and
  `shell` (a plain terminal in the project folder).
- The agent is Pi on `claude-bridge/claude-opus-5-5` at high thinking, on session
  `<project>-<generation>`. Opening the project always resumes the same conversation.
- All agents follow one central rule set: `~/.pi/agent/AGENTS.md` plus the standards in
  `~/.config/agents/standards/`. There is no per-project AGENTS.md to maintain.
- What the agent learns about the project it writes down itself in `notes/PROJECT.md`,
  `notes/STATE.md` and `notes/knowledge/`. Those, with the standards, are loaded into every
  session automatically. Durable facts also go to memini, namespace `homelab/<project>`.
- Everything under `~/Development`, the Pi sessions and the agent history is backed up
  every hour to BigMouth.

## Daily use

Connect the Rex app to aether, pick the project's session and talk to the agent in the
`pi` tab. Nothing needs to run on the Mac.

The agent edits, tests and commits locally on its own. It asks you in the tab before
anything that leaves aether or changes a shared system: git push, merging or opening PRs,
other GitHub writes, kubectl, flux, talosctl and helm changes, chezmoi apply and every
Home Assistant write. Answer the prompt in the tab. Subagents it starts are blocked from
those commands outright.

## Commands on aether

Run these in any aether shell (fish).

| Command | What it does |
|---|---|
| `agent <project>` | Open the project. Creates its Rex session and tabs if missing, starts Pi in the `pi` tab if it is not running. A brand new project folder is created the first time |
| `agent up` | The same for every active project. Run it after a reboot or a Rex upgrade: Rex brings back tabs and scrollback but not the programs in them |
| `agent ls` | One line per project: lifecycle, folder, Rex session, whether Pi runs, generation, and each repo's branch, dirty state and unpushed commits |
| `agent adopt <project>` | Take over a folder that already exists but was never set up by the platform. It only inspects and records, it changes nothing |
| `agent archive <project>` | Stop the project's agent and leave it out of `agent up`. Files, tabs and backups stay |
| `agent-run --register <project> <repo> [url]` | Add a code repo to a project as a submodule. With a URL it clones or registers the existing checkout, without one it makes a local-only repo. The agent normally does this itself |
| `aether-backup status` | When the last backup succeeded |
| `ai-sync` | Refresh all keys from 1Password: model keys, `gh` login, per-project secrets, backup password. Run it after rotating any of them |

## Commands inside Pi

| Command | What it does |
|---|---|
| `/rotate [note]` | Hand off to a fresh session: the agent updates its notes, saves facts to memini, commits the workspace, writes a handoff, and Pi restarts on the next generation with that handoff as its first message |
| `/reload` | Reload extensions and settings after a dotfiles change |
| `/compact [focus]` | Compact the conversation now. Rarely needed: Opus compacts by itself near 250K tokens |
| `/quit` | Stop Pi. The tab stays, `agent <project>` starts it again |

The footer shows `rotate due` when a session passes 100 MB, 5 compactions or 30 days. When
the agent finishes its task while a rotation is due, it asks you once. Rotation never
happens in the middle of a task.

## Adding a project

1. Add an entry to `home/.chezmoidata/projects.yaml` in the dotfiles: lifecycle, optional
   seed repos, and secrets as 1Password references. Defaults (model, thinking, rotation
   limits) can be overridden per project.
2. Push the dotfiles, then on aether `chezmoi update` and `ai-sync` (it writes the project's
   secrets to `~/.local/state/ai/projects/<project>.env`, which the project's `mise.toml`
   loads).
3. `agent <project>`. The first run creates the folder, clones the seed repos as
   submodules and starts the agent. Give it its first brief in the `pi` tab.

The agent adds its own tools to the project's `mise.toml`. System packages and anything
outside the project need your yes, and a tool two projects use is proposed for the base
setup in the dotfiles.

## Where things are

| Path on aether | What |
|---|---|
| `~/Development/<project>/` | The workspace: `notes/`, `plans/`, `scripts/`, `mise.toml`, code repos as submodules, `.worktrees/` for task branches |
| `~/Development/<project>/.agent/` | Runner state: current generation, handoffs, locks. Not in git, but backed up |
| `~/.config/agents/standards/` | The central standards, versioned in `manifest.json` |
| `~/.config/agents/projects.json` | The rendered project registry |
| `~/.pi/agent/sessions/` | Pi conversations, one folder per project path |
| `~/.local/share/agent-history/<project>/` | Raw history from before the move to aether, for grep |
| `~/.local/state/agents/` | Which projects were initialized or adopted, and archive state |
| `~/.local/state/ai/` | Credential caches written by `ai-sync`. Never backed up |

## Backup and restore

Every hour `aether-backup` sends an encrypted restic snapshot to BigMouth
(`sftp:aether-backup@192.168.69.15:/aether/restic`, dataset `Vault/Backups/aether`). Kept:
48 hourly, 30 daily, 12 weekly, 12 monthly. BigMouth snapshots that dataset hourly as well,
so even a deleted repo can be recovered. A failed run, or no success for two hours, sends a
Pushover push. The restore runbook is the Restore section of [aether](aether.md).

## Current projects

| Project | What | Repos |
|---|---|---|
| `home` | Jan's Home Assistant config | `home-assistant` (janpuc/home-assistant) |
| `bigmouth` | BigMouth NAS storage and its off-site backup plan | none yet |
| `thesis` | Jan's engineering thesis (AGH): multi-tier compute for games on handhelds, a Bevy voxel case study | none, the PoC code lives in the workspace |
| `gaming` | BC250 gaming box, inFamous on the Steam Deck (native port, recomp), game reverse engineering (TDU, XBOX, spore). Not renplay | `bc250` (janpuc/BC250), local-only `bc250-control-center`, `infamous-reborn`, `infamous-work` |

## Limits to know

- All agents run as `ubuntu` with no isolation between projects. A gVisor design for later
  is in [isolation-gvisor](isolation-gvisor.md).
- The approval prompt checks command patterns. It is a safety net, not a sandbox.
- One Claude login is shared by every agent, so their usage counts against the same plan.
