# Project agents: user guide

Aether runs Jan's personal project agents, sisyphus the single coordinating work
project and its tasks. Jan talks to them through Rex on hermes. The platform design
is in [projects](projects.md), host details in [aether](aether.md) and
[sisyphus](sisyphus.md).

## The shape of it

- A project is a folder `~/Development/<project>` on aether or `~/Work/work` on
  sisyphus: a local git repo (the workspace)
  with the project's code repos inside as git submodules, plus notes, plans and scripts.
- Each project has one Rex session named after it, with two tabs: `pi` (the agent) and
  `shell` (a plain terminal in the project folder).
- The agent is Pi on `claude-bridge/claude-opus-5-5` at high thinking, on session
  `<project>-<generation>`. Opening the project always resumes the same conversation.
- All agents follow one central rule set: `~/.pi/agent/AGENTS.md` plus the standards in
  `~/.config/agents/standards/`. There is no per-project AGENTS.md to maintain.
- What the agent learns about the project it writes down itself in `notes/PROJECT.md`,
  `notes/STATE.md` and `notes/knowledge/`. Those, with the standards, are loaded into every
  session automatically. Durable facts also go to memini, namespace `homelab/<project>`
  on aether or `work` on sisyphus. Sisyphus has its own key and no personal inheritance.
- Aether backs up `~/Development`, Pi sessions and agent history hourly to BigMouth.
  Sisyphus backs up Work and agent state only after its separate NAS provisioning,
  enable marker and restore drill.

## The platform owner

`dotfiles` is an ordinary, always-on project on aether. Its workspace contains the
`dotfiles` submodule from `https://github.com/janpuc/dotfiles.git`. It owns platform
setup and migration, the registry, standards, runner and central AGENTS.md. Jan will
give it its first brief separately. Other agents request platform work with
`agent ask dotfiles "<outcome, reason, done check>"`. Nothing waits on a laptop agent.

## Daily use

Connect the Rex app to aether for personal projects or sisyphus for work, pick the
project's session and talk to the agent in its `pi` tab. Nothing executes on hermes.

The agent edits, tests and commits locally on its own. It asks you in the tab before
anything that leaves aether or changes a shared system: git push, merging or opening PRs,
other GitHub writes, kubectl, flux, talosctl and helm changes, chezmoi apply and every
Home Assistant write. Answer the prompt in the tab. Subagents it starts are blocked from
those commands outright.

## Commands on execution hosts

Run these on the project's host, or on the hermes laptop. The laptop reads the registry
and dispatches over SSH to the project's host, without a local agent or inbox.
`agent ls` and `agent task ls` prefix laptop output with the host. `agent restart all`
restarts running project and task sessions. `agent -h`, `agent --help`, `agent help`
and `agent task -h` show the same grouped help in fish and sh.

Laptop requests from a registered `~/Development/<project>` path use that project
as the sender. Outside one they come from `jan`, with replies delivered to the ordinary
aether inbox of `dotfiles`. Registered Work paths dispatch as `work` to sisyphus.
A project agent cannot send as `jan` or impersonate `dotfiles`.

| Command | What it does |
|---|---|
| `agent <project>` or `agent open <project>` | Open the project. Creates its Rex session and tabs if missing, starts Pi in the `pi` tab if it is not running. A brand new project folder is created the first time |
| `agent up` | The same for every active project. Run it after a reboot or a Rex upgrade: Rex brings back tabs and scrollback but not the programs in them |
| `agent scratch "<brief>"` | Start free-standing work as a task of the host's scratch project (`scratch` on aether, `work` on sisyphus) in its own tab. `--slug name` picks the id, otherwise it is `s-<yymmdd-hhmm>`. `agent scratch` alone opens the scratch project, `agent scratch ls` lists, `agent scratch restart <id>` resumes |
| `agent scratch fold <id> <project>` | Close a scratch task and send its fold to that project, whose agent copies in what belongs. The scratch folder stays |
| `agent scratch promote <id> <name>` | Ask dotfiles to register a new project from a scratch task, then fold it there |
| `agent ls` | One line per project: lifecycle, folder, Rex session, whether Pi runs, generation, open requests, a pending restart, and each repo's branch, dirty state and unpushed commits |
| `agent adopt <project>` | Take over a folder that already exists but was never set up by the platform. It only inspects and records, it changes nothing |
| `agent archive <project>` | Stop the project's agent and leave it out of `agent up`. Files, tabs and backups stay |
| `agent ask <project> <text>` | Ask the owner of another project's system to do work. The request lands in that project's inbox and Jan decides whether its agent sees it |
| `agent reply <project> <id> <text>` | Answer a request you accepted. The reply lands in the requester's inbox and Jan decides the same way |
| `agent restart <project>\|all` | Restart a project's agent, or every running one, on the same generation and session, to load new central config. `all` skips projects whose Pi is not running |
| `agent-run --register <project> <repo> [url]` | Add a code repo to a project as a submodule. With a URL it clones or registers the existing checkout, without one it makes a local-only repo. The agent normally does this itself |
| `aether-backup status` | When the last backup succeeded |
| `ai-sync` | Refresh all keys from 1Password: model keys, `gh` login, per-project secrets, backup password. Run it after rotating any of them |

## Cross-project requests

Every project agent owns its systems and changes only its own. Another project's
system is changed by asking its owner.

| Project | Owns |
|---|---|
| `dotfiles` (aether) | The platform, dotfiles, registry, standards, runner and central AGENTS.md |
| `work` (sisyphus) | All work projects, tasks, work credentials and work host coordination |
| `network` | UniFi gateway, Wi-Fi, firewall, Tailscale, DNS |
| `kubernetes` | home-ops, the cluster, Flux, Talos |
| `agh` | Jan's studies at AGH: numerical methods, algorithms, networks lab, exam prep | local-only `wypozyczalnia-samochodow` (its GitHub copy is gone) |
| `ai` | Jan's AI tooling: Pi packages, model evals, the local models on sisyphus | `pi-usage`, `pi-footer`, `pi-title-spinner`, `pi-claude-bridge`, `pi-optchat`, `pi-model-eval`, `mac-models` |
| `polished` | Self-hosted nail polish inventory (Python server, iOS app built on the Mac) | `polished` |
| `austerity` | austerity.watch, the public map of the 2026 protest wave in Europe | `austerity-watch` |
| `maker` | Xiao ESP32 boards and 3D-printed cases, earlier ESP32 experiments | none, local repo `esp32/mmWave1` pending |
| `home` | Home Assistant and the DietPi speakers |
| `bigmouth` | the NAS |
| `renplay` | renplay-org repositories and deploys |
| `gaming` | the BC250, the Steam Deck and the game ports |
| `thesis` | the thesis |

`agent ask <project> <text>` writes a request into the target's inbox. `agent ls`
counts the open ones. The target's Pi picks each new request, reply or task fold up by
itself within 30 seconds: at once when idle, otherwise as a follow-up after the current
run, never interrupting it. There is no prompt. `/inbox` lists the recent items and
their status. A request that is not the owner's to do gets a reply saying so.

Requests are plain JSON in `~/Development/<project>/.agent/inbox/`, outside git and
inside the backup. Reading
another aether project's notes and memini namespace on aether is allowed, changing
them is not. Work agents read no personal material and dotfiles never reads Work.

## Tasks

Tasks are bounded work inside a registered project, not new projects. From the laptop
or aether:

```sh
agent task new home --slug speaker-audit "Audit the speaker configuration"
agent task new home HA-123 "Investigate ticket HA-123"
agent task new home --wait HA-125
agent HA-126
agent task ls
agent task ticket home speaker-audit HA-124
agent task restart home speaker-audit
agent task close home speaker-audit
```

With `--wait` the brief is optional and Pi starts without its first prompt. Paste the
ticket into the new tab as the first message, and the agent saves it into BRIEF.md.
The new tab is shown in every connected Rex app, since Rex cannot say which one you use.

`agent <TICKET>` shows the task with that id if a project on its host has one, and
restarts it if it stopped. Otherwise it opens it with `--wait` in the current project, or
outside a project in the registry's `platform.tickets` project, which is work.

Inside a project session, omit `home` from task commands. Ticket ids match
`^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$`, slugs match `^[a-z0-9][a-z0-9-]{1,39}$`.
Attaching a ticket never renames the id, folder, branch or session. Closed ids are
never reused. Four tasks may be open by default, including a close in progress.

A task runs in Rex tab `task:<id>` of the project, in Pi session `<project>-task-<id>`.
Its cwd is `tasks/<id>/`, which separates its Pi history from the project history.
`PI_PROJECT_DIR` still names the workspace. BRIEF.md contains id, ticket, opened and
status front matter. STATE.md is the task's state, with project facts and central
standards injected alongside both. Needed code worktrees go in
`.worktrees/<repo>/<id>/` on branch `task/<id>`, created by the task agent only when
needed. Task sessions do not rotate. Restart resumes the same task conversation.

Close waits for the task's next idle boundary, asks it to write RESULT.md with Outcome,
Changes, Verification, Learned and Open, then sends a `fold` request to the project
inbox. Jan accepts the fold before the project agent updates shared notes. A close
that fails stays `closing` and counts toward the limit. Resolve its blocker and repeat
close. Nothing is deleted: folders, branches, worktrees, sessions and drafts remain.
Tasks may write their own folder, new knowledge evidence pages and their worktrees,
not project PROJECT.md, STATE.md or other tasks. Close all open tasks before archiving
the project.

## Fixed memini namespaces

The platform owns namespace names. `personal/jan` holds personal facts, `homelab`
small shared infrastructure facts and `homelab/<project>` every registered aether
project. Tasks use their project's namespace with `ticket:<ID>` or `task:<slug>`
tags and project, task id and ticket metadata, never a task child namespace.
Outside a registered project, aether and the Mac use `homelab/scratch`, including
unknown Git repos. Work sessions use the fixed `work` namespace, including laptop intake. No new
namespace is derived from a directory. Sisyphus never exports `MEMINI_HOME`.

## Rex navigation

The aether-managed `~/.config/rex/init.lua` defines these keys:

| Keys | Action |
|---|---|
| Ctrl+Cmd+A | Toggle Activity sidebar |
| Ctrl+Cmd+F | Focus sidebar filter |
| Ctrl+Cmd+G | Go to Anything |
| Ctrl+Cmd+V | View Activity |
| Ctrl+Cmd+H | Go to home |
| Ctrl+Cmd+N | Go to a waiting agent, blocked first, then done |

`rex do go_project name=dotfiles` jumps to a named project. Sessions sort with `dotfiles`
first, then alphabetically. The project Pi tab has no forced title, so Pi's own title
can show. Its window id is retained for reconciliation. Task tabs keep `task:<id>`.
Rex's tab indicators are the activity signal (OSC 7501). The redundant
`pi-title-spinner` package is retired on all hosts. Pi's own program title, such as
`π - home`, stays, it is not replaced by a spinner.
After changing the Lua config, run `rex config reload` **on aether**. Remote reload
is refused, and a Mac-local config does not control aether sessions. The scan action's
app focus behavior still needs an interactive smoke check.

## Loading new config

After a dotfiles change to AGENTS.md, the standards, the extensions or the Pi
settings, run `chezmoi update` and then `agent restart all`. Each running agent
finishes its current run, then restarts on the same generation and session, so the
conversation resumes with the new config. A request waits while a run or a confirm
prompt is open. `agent ls` shows `restart=pending` until the restart happens.

## How to change the platform

The platform and Jan's machine config live in one repo, janpuc/dotfiles. `dotfiles` owns it and
works in its checkout on aether (`~/Development/dotfiles/dotfiles`).

- Platform changes (a project, a standard, agent behaviour, Pi config): `agent ask dotfiles "..."`
  from anywhere, or talk to `dotfiles` in its Rex tab. It branches, edits, tests, commits and
  pushes, then reports. After the push it runs `chezmoi update` and `agent restart all`
  on aether, and on sisyphus with its three permitted commands.
- Mac-only changes (Homebrew, macOS defaults, fish on the Mac) go through `dotfiles` the same way.
  Jan then runs `chezmoi update` on the Mac.
- Editing by hand in the Mac's `~/.local/share/chezmoi` is fine: pull first, commit and push
  right away. `dotfiles` pulls before every change and never force-pushes.
- Agents never edit dotfiles themselves. They ask `dotfiles`.

## Commands inside Pi

| Command | What it does |
|---|---|
| `/rotate [note]` | Hand off to a fresh session: the agent updates its notes, saves facts to memini, commits the workspace, writes a handoff, and Pi restarts on the next generation with that handoff as its first message |
| `/inbox` | List the open cross-project requests and offer them again |
| `/reload` | Reload extensions and settings after a dotfiles change |
| `/compact [focus]` | Compact the conversation now. Rarely needed: Opus compacts by itself near 250K tokens |
| `/quit` | Stop Pi. The tab stays, `agent <project>` starts it again |

The footer shows `rotate due` when a session passes 100 MB, 5 compactions or 30 days. When
the agent finishes its task while a rotation is due, it asks you once. Rotation never
happens in the middle of a task.

## Adding a project

Ask `dotfiles` to set up or migrate a project. It follows this procedure:

1. Add an entry to `home/.chezmoidata/projects.yaml` in the dotfiles: lifecycle, optional
   seed repos, and secrets as 1Password references. Defaults (model, thinking, rotation
   limits) can be overridden per project. Host defaults to `aether`, providers preserve
   the existing personal model choices, and `tasks.maxOpen` defaults to four.
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
| `~/Development/<project>/` | The workspace, including retained `tasks/<id>/` folders: `notes/`, `plans/`, `scripts/`, `mise.toml`, code repos as submodules, `.worktrees/` for task branches |
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
| `dotfiles` | Always-on platform owner | `dotfiles` (janpuc/dotfiles) |
| `home` | Jan's Home Assistant config and the DietPi AirPlay speaker nodes | `home-assistant` (janpuc/home-assistant), `dietpi/` as plain content |
| `bigmouth` | BigMouth NAS storage and its off-site backup plan | none yet |
| `thesis` | Jan's engineering thesis (AGH): multi-tier compute for games on handhelds, a Bevy voxel case study | none, the PoC code lives in the workspace |
| `gaming` | BC250 gaming box, inFamous on the Steam Deck (native port, recomp), game reverse engineering (TDU, XBOX, spore). Not renplay | `bc250` (janpuc/BC250), local-only `bc250-control-center`, `infamous-reborn`, `infamous-work` |
| `network` | Jan's home network: UniFi gateway, Wi-Fi and VLANs, firewall, Tailscale and split DNS, Thread and Matter | none, audits, config backups and scripts live in the workspace |
| `kubernetes` | Jan's Talos and Flux homelab cluster | `home-ops` (janpuc/home-ops), worktrees under `.worktrees/home-ops/` |

## Cluster access from the Mac

The Mac keeps working with the cluster from any folder: `~/.kube/config` is the homelab
kubeconfig and `~/.talos/config` the talosconfig, so `kubectl`, `k9s`, `flux` and `talosctl`
need nothing set. `kubectx` still switches to the work clusters through `KUBECONFIG`, and
`kubectx -u` returns to the homelab. On aether the same two files live untracked in
`~/Development/kubernetes/home-ops/`.

## Work on sisyphus

The `work` project at `~/Work/work` coordinates work, with no seed repositories.
Register the existing 17 checkouts during the separate migration, do not reclone.
`dotfiles` may SSH there only for `agent ls`, `agent restart all` and `chezmoi update`,
never read `~/Work`. Work asks dotfiles for platform changes through the restricted
inbox endpoint on aether and pulls replies, dotfiles never connects to deliver one.

The work guard adds AWS writes, terraform changes and prod-profile assumptions to
all existing rules. Work secrets come from its own Work-vault service account,
model and infrastructure keys from the existing Kubernetes account. WBD uses
`aws sso login --use-device-code` in the Work tab, SAML profiles arrive through
`work-creds <profile>` on hermes, which refuses static keys.

See [sisyphus](sisyphus.md) for the ordered deployment, keep-awake daemon, approval-
gated model deletion, disabled-until-provisioned backup, separate Work migration
and permanent wipe. `work-wipe` defaults to a dry run and needs `--really` to delete.
It is not migration cleanup. `/delegate` and automated migration remain out of scope.

## Limits to know

- All agents run as `ubuntu` with no isolation between projects. A gVisor design for later
  is in [isolation-gvisor](isolation-gvisor.md).
- The approval prompt checks command patterns. It is a safety net, not a sandbox.
- One Claude login is shared by every agent, so their usage counts against the same plan.
