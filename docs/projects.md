# Multi-host agent platform

Aether is Jan's always-on personal execution host, an Ubuntu ARM VM running every
project agent as ubuntu. The Mac is a Rex client. Work repositories stay off aether.
There is no isolation layer. docs/isolation-gvisor.md is a deferred alternative.
The registry assigns aether to personal projects and sisyphus to work. dotfiles is an ordinary
always-on aether project with a dotfiles/ seed submodule, not a laptop sender or a
special inbox. It owns platform setup, migration, registry, standards, runner and
AGENTS.md. Jan supplies its first brief separately.
Aether is the authoritative workspace writer unless Jan explicitly transfers ownership.
Do not run divergent authoritative copies on the Mac and aether.

## Platform phases

Phase 1 added registry hosts and providers, main, task sessions, a hermes SSH
dispatcher, fixed memini namespaces and managed Rex navigation. Phase 2 adds the
work host, guard, credentials, keep-awake, gated model retirement, disabled backup
and safe wipe. The Work migration remains separate, as do /delegate and automated
migration commands. See [sisyphus](sisyphus.md) for setup and the deployment order.
dotfiles may SSH there only for agent ls, agent restart all and chezmoi update, never
read ~/Work. Work asks dotfiles through a restricted aether endpoint and pulls replies.

Validation is offline, with read-only host discovery. No live changes, GitHub,
1Password, memini or chezmoi apply are part of this build. Deployment, restore drills
and interactive Rex title, close and fold checks remain manual.

## Previous build status

This change implements build-plan steps 1 to 6: data contracts, local workspace
bootstrap, safe repository registration and recovery, launcher lifecycle, central
standards, the Linux instruction preamble, persistent context injection and the
rotation update, plus the hourly encrypted backup. The Linux run_onchange scripts install
the backup scripts and system units. The live home workspace runs on v2 since 2026-11-18 (generation 2).

Done on 2026-11-18: a restore drill (latest snapshot into /tmp, git fsck clean in the
workspace and the submodule, uncommitted STATE.md byte identical, sessions and history
intact) and the home migration below. Not checked yet: context injection after a
compaction in the middle of a run on the real bridge.

The hourly encrypted restic backup to BigMouth is built and enabled on aether, see
[aether](aether.md) for its scope, exclusions and restore steps. It is online only:
there is no nightly checkpoint, quiescence or backup barrier, and an online file copy is
not an atomic filesystem snapshot. Do not claim these local-only workspaces are protected
until an isolated restore drill actually succeeds.

## Registry contract

home/.chezmoidata/projects.yaml renders to ~/.config/agents/projects.json on Linux
and Mac.

hosts.aether defines root ~/Development, meminiPrefix homelab, meminiHome personal/jan
and guard personal. hosts.sisyphus defines root ~/Work, namespace work, meminiHome
none, guard work, providers all, vault Work and maxAgents five. Its single work
project has no seeds and GH_TOKEN from op://Work/github/GH_TOKEN. Sisyphus secrets
must use Work and aether secrets must never use Work, checked at registry render.
Each project has host (default aether), providers and tasks.maxOpen
(default four). The render resolves these fields into projects.json. Defaults retain
model claude-bridge/claude-sonnet-5-5 (Opus until 2026-11-23), thinking high and rotation sizeMB 100, compactions 5,
days 30. Providers preserve today's claude-bridge, openai, minimax, opencode-go, alibaba
and litellm choices. The runner removes cached and plain provider keys when disallowed,
not all PI_* identity variables. This is configuration, not network isolation or a
sandbox. A project may override model, thinking and individual rotation thresholds. Keep secrets as environment names mapped
to op:// references. The optional apt list extends the platform package layer.

Project lifecycle is active or archived, defaulting to active. Optional repos entries
are one-time initialization seeds with a unique name and optional clone URL. Omitting
a URL creates a local-only member. After initialization, .gitmodules is authoritative,
not the seed list. Changing or removing seeds does not change existing membership.
No GitHub workspace remote is required. The home entry is active with home-assistant
as a seed and the existing HA_TOKEN secret reference. The old janpuc/home-workspace
remote is preserved on the live workspace until approved migration, not cloned by
the new launcher.

Project and member names are single directory components beginning with a letter or
digit and containing only letters, digits, dots, underscores and hyphens. Project
names up, ls, open, help, archive, adopt, ask, reply, restart, task, todo, digest, scratch,
watch, schedule, doctor and jan are reserved, except that a host's own scratch project
may be named scratch. dotfiles is an ordinary registered project. jan is a laptop-only
request sender, refused inside project sessions. Replies for jan land in the dotfiles
project's ordinary inbox. Member paths notes, plans, scripts and tasks are reserved. Names
and paths must be unique, relative and contained without symlink escapes. Members remain
direct children of the workspace.

## Local workspace and initialization

```text
~/Development/<project>/
├── .git/
├── .gitmodules                   Membership, URLs and local-only markers
├── .gitignore                    .agent/ and .worktrees/ only
├── mise.toml                     Tools, tasks and non-secret environment
├── notes/
│   ├── PROJECT.md                 Facts, constraints, systems and knowledge index
│   ├── STATE.md                   Current work, verification and pending approvals
│   └── knowledge/<topic>.md       Dated evidence and history
├── plans/
├── scripts/
├── <repository>/                 Git submodule
├── <non-git-folder>/              Ordinary tracked workspace content
├── tasks/<id>/                   BRIEF.md, STATE.md and RESULT.md at close
├── .worktrees/<repo>/<task>/      Linked task worktrees, branch task/<id>
└── .agent/
    ├── generation
    ├── handoff-<N>.md
    ├── rotate-requested
    ├── restart-requested
    ├── context.json              Derived context revision, digests and hashes
    ├── inbox/<id>.json           Cross-project requests and replies
    ├── tasks/<id>/               Task metadata, close/restart markers, context and lock
    └── run.lock
```

A genuinely new workspace is assembled in a temporary sibling tree with git init,
standard knowledge headings, optional secret env reference and seed submodules. It
gets an initial local workspace commit, then is installed by rename. Normal Git user
identity must already be configured. No per-workspace AGENTS.md is created. Empty
layout directories are created on disk but not filled with tracked placeholder files.

Durable records outside the workspace live under ~/.local/state/agents:

- initialized/<project> is JSON with schemaVersion 1, project, absolute workspace,
  origin bootstrap or adopted, and state initializing or initialized
- lifecycle/<project> is active or archived text and overrides registry lifecycle
- locks/<project> serializes initialization, registration, adoption, archive and Rex
  reconciliation even when the workspace does not yet exist
 Initialization
writes an initializing record before staging. Ordinary pre-install failure removes
that record and the temporary tree so a retry is possible. A crash or post-install
record failure remains visibly incomplete and needs operator recovery. A missing
previously initialized workspace reports restore needed and is never recreated.
The hourly backup includes these records with the rest of platform state.

An existing directory without a record fails with adoption required. agent adopt
<project> verifies a Git root, reports workspace dirt and member branch, dirty and
ahead state, including discovered unregistered child repositories, then records
origin adopted. It does not consume seeds, register legacy members, change branches
or migrate knowledge. It is explicit acknowledgement of existing data, not the home
migration procedure. Removing a registry entry never deletes a directory.

## Repository operations

Code repositories are native Git submodules, tracked by .gitmodules and workspace
gitlinks. Non-Git folders such as plans and ha-inventory remain ordinary workspace
content. Each member owns its branches and commits. Workspace checkpoints explicitly
stage updated gitlinks after intentional member commits. Never manufacture a commit
to hide a dirty tree. Always use git -C <explicit repository path> and explicit paths
when staging. Never git add -A at the workspace root.

Register with:

```text
agent --register <project> <member> [url]
```

This requires an initialized workspace, registers an existing Git root without
changing its branch or files, or prepares a new member in a temporary directory.
It stages .gitmodules and the gitlink and initializes native submodule configuration.
It does not commit the workspace checkpoint for the caller.

Without a URL, a new repository gets an initial local commit before registration:

```ini
[submodule "example"]
    path = example
    url = local-only://project/example
    agent-local-only = true
```

Workspaces created before the Go runner carry aether-local-only, which is still read.

The marker is intentionally non-resolvable. A missing local-only member fails with
restore needed, never a clone attempt or an empty replacement. Publishing later
requires approval and explicit replacement with a real URL and removal of the marker.

On launch, existing registered members are inspected only. The runner never resets,
pulls, switches branches or invokes git submodule update. Dirty trees and detached
HEADs stay untouched, including when they differ from the committed gitlink.

A missing remote member is cloned to temporary storage, obtains the workspace HEAD's
committed gitlink revision, creates the named branch agent-restored at that exact
commit and installs the checkout by rename. It does not restore at the remote's
current default branch. Authentication, missing commit or installation failures stop
launch without a partial member. A registered member without a committed gitlink
must be checkpointed before it can be recovered. Recovered repositories can retain
a standalone .git directory, the supported old-form submodule layout.

## Launcher and Rex

The agent command in ~/.local/bin is the only entry point and the runner.
The runner resolves its own hostname in hosts, exports PI_PROJECT_ROOT and serves
only projects assigned to that host. Unknown execution hosts fail closed. Help and
validation have one implementation. agent -h, --help, help and task -h list grouped
commands, examples and Pi commands. On hermes it is a dispatcher only: every supported
command goes over SSH to registry-resolved hosts. ls and task ls prefix each line
with its host. Outside a registered laptop project, ask sends as jan and routes replies
to dotfiles on aether. Inside one it sends as that project, never as dotfiles.

The project operations are:

- agent <project> or agent open <project> initializes if genuinely new, safely checks members and reconciles Rex
- agent up starts only active projects with the same idempotent reconciliation
- agent ls prints lifecycle, initialization state, folder, Rex ID, runner liveness and
  generation, then member branch, dirty and ahead summaries. No upstream means ahead
  is unknown. It also reports unregistered workspace directories and child repositories
- agent adopt <project> explicitly records an inspected existing workspace
- agent ask <project> <text> writes a request into the target's .agent/inbox. agent
  reply <project> <id> <text> answers the original sender's inbox from a request in
  the current project's inbox. Unknown, archived and self targets are refused
- agent restart <project>|all writes an atomic .agent/restart-requested marker so each
  agent loads updated central config. all includes active running project and task agents
- agent ls also counts open requests and shows restart=pending while a marker waits
- agent archive <project> stops the managed Pi block and writes a local archived record,
  without deleting or moving files. It matches the Rex child PID against the live
  runner lock and waits for that lock to release. Ambiguous tabs, unknown runner PIDs
  and unmanaged live programs fail closed. Other tabs and the Rex session are retained

A local archived record wins over registry active. Direct launches of archived projects
are refused. To reactivate, an operator must intentionally remove or change the local
record and ensure registry lifecycle is active. There is no automatic deletion or
unarchive command. Archived projects remain in backup scope. `aether-backup status`
prints the last successful backup from a local record on aether, written only after a run
succeeds.

Each project has a Rex session with its exact label and Pi and shell tabs at the
workspace root, created together in session.create with initial_windows. Pi uses
--keep-open. Its tab has no explicit window label so the program title can show.
.agent/rex-window records the stable window id and migrates the former pi label.
Task tabs keep their task:<id> labels. Sessions sort dotfiles first, then alphabetically. Repeated launches create only missing resources.
A stopped or idle-shell pi terminal is replaced within its existing tab. Multiple
panes or a live unmanaged process are left alone. The external project lock prevents
concurrent launches from duplicating initialization or Rex resources. The runner's
.agent/run.lock spans startup, model execution and rotation.

The tab is shown in every connected Rex app, since Rex cannot say which one Jan is looking
at. An app that is asleep or without Remote Control only gets a warning. Remote Control
must be enabled by Jan. Hermes has the registry and dispatcher but no local project
execution or standards installation. Sisyphus runs the shared
runner with Work standards, mise tools and trust, using launchd for its host services. For remote inspection use
rex -S aether ls --json and rex -S aether client ls.

## Tasks

agent task new [project] <TICKET-ID|--slug slug> "<brief>" creates a retained task
folder and starts its Rex tab in the project's session. The project is optional only
when PI_PROJECT or a registered laptop path identifies it. agent task ls [project],
ticket [project] <slug> <TICKET>, close [project] <id> and restart [project] <id> manage it.
Ticket ids match ^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$ and slugs ^[a-z0-9][a-z0-9-]{1,39}$.
The id is immutable and never reused. Ticket attachment updates BRIEF front matter
and runtime metadata without renaming paths, task/<id> branches or sessions.

Cwd is tasks/<id>/, giving each task a separate Pi history directory and session id
<project>-task-<id>. PI_PROJECT_DIR stays the project root. STATE.md belongs to the
task, while project facts come from notes/PROJECT.md. Tasks create code worktrees
only as needed under .worktrees/<repo>/<id>/. No task rotation is implemented.

.agent/tasks/<id>/meta.json records id, ticket, opened and status open, closing or
closed. A close-requested marker triggers an idle-boundary message to the task agent
asking it to write RESULT.md with Outcome, Changes, Verification, Learned and Open.
After TASK_CLOSE_READY the extension validates headings and calls the runner to
finalize. It writes an idempotent fold request to the project inbox before closing
metadata and the closed marker, then gracefully stops Pi. The fold waits for Jan.
Failed closes retain data and stay closing, counting toward maxOpen. Repeat close
after resolving the blocker. A task whose Pi stops without closing it writes one exit
notice into the project inbox, so a child that dies mid turn is never left waiting on
nobody and the project does not treat it as idle. Closed ids, folders, worktrees, branches and sessions
are never deleted or reused. Runtime metadata and result writes are not one atomic
transaction, but finalization can be retried without duplicating an accepted fold.

## Rex navigation

The Linux allowlist installs ~/.config/rex/init.lua on aether. Ctrl+Cmd+A toggles
Activity, F filters, G opens Go to Anything, V views Activity, H jumps to home and N
selects a waiting agent, blocked before done. rex do go_project name=dotfiles jumps by
name. rex config check validates locally. rex config reload must run on aether,
not through a remote Rex connection. The app-side focus behavior of the scan and
the title presentation need an interactive smoke check after deployment.

## Tools and credentials

Three layers remain: dotfiles platform essentials, workspace mise.toml, and legitimate
member tool configuration. Use latest Pi, Node and Rex aligned across machines, not
pinned platform versions. Agents may add workspace user-space tools and scripts,
record why, check ARM support and smoke test. Host-wide packages, services and
privileged configuration need Jan. Tools useful across projects become reviewed
dotfiles proposals. No tool-manager files are added to deployment repositories merely
for agent convenience.

The runner loads mise env --json from the workspace and prepends
${MISE_DATA_DIR:-~/.local/share/mise}/shims. Each shim resolves tools for its command's
cwd. The Pi wrapper resolves absolute Node and Pi paths via mise which while keeping
shim-first PATH. A shim cannot change its parent shell environment after cd. Use
mise exec -- <command> for an ordinary system command needing nested mise environment.
Mise trusts ~/Development on Linux. Pi's additive trust modifier preserves other trust
decisions rather than enabling defaultProjectTrust always.

Host-local ai-sync keeps shared credential handling and writes project env files under
~/.local/state/ai/projects/. They are mode 0600 in a mode 0700 directory, with quoted
single-line values and escaped dollars. Atomic replacement occurs only after all of
a project's secrets are fetched. A failed refresh preserves its old file and returns
an error. The runner validates required secret keys and fails startup if missing.
Do not log values or commit generated env files. Tests use temporary HOME and state
paths and never invoke ai-sync against real user state.

## Instructions, knowledge and approvals

home/dot_pi/private_agent/AGENTS.md.tmpl is the only platform-maintained AGENTS.md.
Its aether and sisyphus preambles refer to the mandatory standards under
~/.config/agents/standards. Hermes only loses retired M3 Pro placement and models,
and the redundant title-spinner package is retired everywhere without changing Pi's
own title. The manifest has schemaVersion 1, version 2.4.7, ordered
mandatory file paths with per-file SHA-256 digests computed during this build, and
compatibility metadata. Recompute digests whenever standard content changes.

The standards cover workspace, session, knowledge, git, tools, approvals, handoff,
recovery, requests between projects, platform commands and task lifecycle. requests.md fixes project ownership, the ask
and reply flow and the rule that another project's notes and memini namespace may be
read but not changed. They are mandatory documents, not optional skills. knowledge.md
defines the fixed headings and evidence rules for PROJECT, STATE and topic pages. The
agent owns routine knowledge upkeep. Jan reviews decisions and approvals, not routine
edits.
memini remains supplementary searchable recall in the platform-owned homelab/<project>
namespace, inherited by children. personal/jan holds personal facts and homelab small
shared infrastructure facts. Tasks never create child namespaces: entries use tags
ticket:<ID> or task:<slug> plus project, task id and ticket metadata. Unregistered
sessions on aether and the Mac share homelab/scratch, never a new cwd-derived name.
Work sessions use the fixed work namespace. Sisyphus uses its own memini key with
MEMINI_HOME unset. Memini must not be the only copy of recovery-critical facts.

Agents edit, test and commit locally, and they push, merge their own PRs, deploy, change
the cluster and write to Home Assistant without asking, then report what they did. Decide
small and reversible things yourself, ask only at a real trade-off or something that cannot
be undone. The hard-deny list is refused outright and only Jan lifts one item, for one
command, by telling the agent, which reruns it as AGENT_OVERRIDE. Children cannot override
and report the refused command to their parent. Memory, old handoffs, print, JSON and RPC
cannot lift an item. The command-pattern guard catches mistakes, not arbitrary scripts or
API bypasses. Policy applies through every tool.

Keep model settings and platform instructions out of deployable repositories such
as Home Assistant. Upstream repository instructions may be read but cannot weaken
central approvals. Jan's prose uses minimal punctuation, no em or en dashes, no
semicolons and no ellipses.

## Context injection

home/dot_pi/private_agent/local/project-context.ts is registered in the Pi settings for
all hosts but returns immediately when PI_PROJECT is unset, so laptop intake is unaffected.
It validates PI_PROJECT_DIR as PI_PROJECT_ROOT/<PI_PROJECT>, requires the project in
~/.config/agents/projects.json and reads the ordered manifest. It builds one message
from the standards, notes/PROJECT.md and notes/STATE.md and returns it from
before_agent_start. The bridge forwards that custom message as literal prompt text,
while project context files and system prompt changes are cached from its first
request, so injection must not rely on those routes.

The message is rebuilt before a turn when any loaded file's content hash changes, and
again after a compaction or a new, resumed or forked session. Each message carries the
standards version, the combined standards digest and a context revision, and states
that it supersedes any earlier context message. It also carries a one-line summary of
the new cross-project requests waiting in the inbox. Children inherit PI_PROJECT, PI_PROJECT_ROOT and PI_PROJECT_DIR and receive the same
context. For PI_TASK it loads project PROJECT.md plus tasks/<id>/BRIEF.md and STATE.md,
not project STATE.md. Task context records go in .agent/tasks/<id>/context.json.

Content input is the registry, the standards manifest and files, notes/PROJECT.md and
notes/STATE.md. The knowledge index is in PROJECT.md, and detailed topic pages are read
as needed rather than injected. The budget is 48 KiB of UTF-8 for the standards plus
PROJECT and STATE, taken from the manifest compatibility block. An oversized block, a
missing manifest or listed standards file, and a manifest digest mismatch are reported
in the message and in an error notification. Nothing is truncated. A missing PROJECT
or STATE file is allowed for a new workspace and the message tells the agent to create
it per knowledge.md. .agent/context.json records the revision, digests, per-file hashes
and problems. It is derived state and regenerable, never the source of truth.

A real Pi and bridge verification of startup, resume, compaction, a standards edit and
an oversized STATE on aether is still outstanding. Central AGENTS.md, extension or
settings updates require a clean runner restart or generation rotation. /reload alone
is not sufficient for bridge context refresh.

## Generation loop and rotation

The runner still launches Pi with --session-id <project>-<N> and --model
<model>:<thinking>, exporting PI_PROJECT, PI_PROJECT_ROOT, PI_PROJECT_DIR and exact MEMINI_NAMESPACE.
Handoffs are sent only if that generation has no existing Pi session file. Ordinary
restarts resume without replaying the handoff.

The rotation routine now asks the agent to update notes/STATE.md, notes/PROJECT.md and
the indexed notes/knowledge/ pages per the central standards, store durable facts with
memory_remember, and commit the workspace with git -C <workspace> and explicit paths.
It no longer asks for a project AGENTS.md update, and it forbids creating one. The
generated handoff prompt uses STATE.md and PROJECT.md as evidence, keeps pending
approvals, and tells the next agent that the platform injects the standards.

The extension writes handoff-<N+1>.md before atomically writing rotate-requested, then
requests shutdown. Only the runner advances generation after Pi exits. It recovers
requests interrupted on either side of the generation write. Invalid requests remain
visible. A failed checkpoint or handoff keeps the old session. Old sessions and raw
history remain available.

Existing rotation thresholds, idle prompting and generation semantics are unchanged.
A restart request is treated like a rotation request but keeps the same generation and
session id, so the conversation resumes. The runner clears a restart marker found
before it launches Pi, and removes one written during a run before relaunching.
Runtime .agent state must remain outside workspace Git. The hourly online backup has no
coordination protocol: it can capture a workspace in the middle of a write.

## Home migration (done 2026-11-18)

The generation 1 agent moved its own knowledge into notes/PROJECT.md, notes/STATE.md and six
pages under notes/knowledge/. The main agent then registered the existing home-assistant
checkout as a submodule in place (no reclone, still at 0fea21f), untracked .agent/, removed
the workspace AGENTS.md (a copy is in ~/.local/share/agent-history/home/workspace-AGENTS-v1.md),
dropped the workspace's GitHub remote, ran `agent adopt home` and rotated to generation 2,
which confirmed the injected context. The GitHub copy janpuc/home-workspace stays until Jan
approves archiving it.

The hourly backup includes complete workspaces, Git and submodule stores, uncommitted
and untracked work, local-only commits, .worktrees, runtime generation and handoffs,
Pi sessions, raw history, external platform records and the chezmoi source checkout,
through which the registry and standards are covered. It excludes external credential
caches, runtime locks and narrowly reviewed reproducible caches. Do not add blanket
dependency-lockfile or .env filename exclusions: a workspace lockfile or env sample can
be the only copy of a decision. Treat sessions and untracked content as sensitive even
when encrypted.

Restricted SFTP access, the BigMouth dataset, NAS host-key pinning, snapshot policy and
independent stale-backup monitoring are shared-system work approved with this change and
provisioned outside this repository. A fresh-host restore drill remains a later
deliverable.
