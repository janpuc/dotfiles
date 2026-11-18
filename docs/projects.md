# Projects on aether v2

Aether is Jan's always-on personal execution host, an Ubuntu ARM VM running every
project agent as ubuntu. The Mac is a Rex client. Work repositories stay off aether.
There is no isolation layer. docs/isolation-gvisor.md is a deferred alternative.
Aether is the authoritative workspace writer unless Jan explicitly transfers ownership.
Do not run divergent authoritative copies on the Mac and aether.

## Build status

This change implements build-plan steps 1 to 6: data contracts, local workspace
bootstrap, safe repository registration and recovery, launcher lifecycle, central
standards, the Linux instruction preamble, persistent context injection and the
rotation update. Nothing is applied to aether by this change. The live home workspace
is not migrated.

Not built yet:

- Bridge integration checks for context injection, injection after compaction on real
  Pi and the bridge
- Hourly encrypted restic backup, SFTP provisioning, alerts and restore drill
- Home migration and an operator restore runbook

There is no nightly checkpoint, quiescence or backup barrier. Backup will be hourly
online only. An online file copy is not an atomic filesystem snapshot. Do not claim
these local-only workspaces are protected until backup and an isolated restore drill
actually succeed.

## Registry contract

home/.chezmoidata/projects.yaml renders to ~/.config/agents/projects.json on Linux
and Mac.

Defaults remain model claude-bridge/claude-opus-5-5, thinking high, meminiPrefix
homelab, and rotation sizeMB 100, compactions 5, days 30. A project may override these
values and individual rotation thresholds. Keep secrets as environment names mapped
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
names up, ls, archive and adopt are reserved. Member paths notes, plans and scripts
are reserved. Names and paths must be unique, relative and contained without symlink
escapes. Members remain direct children of the workspace.

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
├── .worktrees/<repo>/<task>/      Linked task worktrees
└── .agent/
    ├── generation
    ├── handoff-<N>.md
    ├── rotate-requested
    ├── context.json              Derived context revision, digests and hashes
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
Back up these records with platform state in the later implementation.

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
agent-run --register <project> <member> [url]
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
    aether-local-only = true
```

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

The Linux-only fish function delegates to ~/.local/bin/agent-run:

- agent <project> initializes if genuinely new, safely checks members and reconciles Rex
- agent up starts only active projects with the same idempotent reconciliation
- agent ls prints lifecycle, initialization state, folder, Rex ID, runner liveness and
  generation, then member branch, dirty and ahead summaries. No upstream means ahead
  is unknown. It also reports unregistered workspace directories and child repositories
- agent adopt <project> explicitly records an inspected existing workspace
- agent archive <project> stops the managed Pi block and writes a local archived record,
  without deleting or moving files. It matches the Rex child PID against the live
  runner lock and waits for that lock to release. Ambiguous tabs, unknown runner PIDs
  and unmanaged live programs fail closed. Other tabs and the Rex session are retained

A local archived record wins over registry active. Direct launches of archived projects
are refused. To reactivate, an operator must intentionally remove or change the local
record and ensure registry lifecycle is active. There is no automatic deletion or
unarchive command. Archived projects remain in future backup scope. Backup freshness
cannot be reported yet because no backup state producer exists.

Each project has a Rex session with its exact label and pi and shell tabs at the
workspace root. Pi uses --keep-open. Repeated launches create only missing resources.
A stopped or idle-shell pi terminal is replaced within its existing tab. Multiple
panes or a live unmanaged process are left alone. The external project lock prevents
concurrent launches from duplicating initialization or Rex resources. The runner's
.agent/run.lock spans startup, model execution and rotation.

If exactly one Rex app is connected, select that session. With several apps do not
choose for Jan. Remote Control must be enabled by Jan. The Mac has the registry but
no project launcher or Linux standards installation. For remote inspection use
rex -S aether ls --json and rex -S aether client ls.

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

Linux ai-sync keeps shared credential handling and writes project env files under
~/.local/state/ai/projects/. They are mode 0600 in a mode 0700 directory, with quoted
single-line values and escaped dollars. Atomic replacement occurs only after all of
a project's secrets are fetched. A failed refresh preserves its old file and returns
an error. The runner validates required secret keys and fails startup if missing.
Do not log values or commit generated env files. Tests use temporary HOME and state
paths and never invoke ai-sync against real user state.

## Instructions, knowledge and approvals

home/dot_pi/private_agent/AGENTS.md.tmpl is the only platform-maintained AGENTS.md.
Its Linux preamble refers to the mandatory standards under ~/.config/agents/standards.
The Mac render is unchanged. The manifest has schemaVersion 1, version 2.0.0, ordered
mandatory file paths with per-file SHA-256 digests computed during this build, and
compatibility metadata. Recompute digests whenever standard content changes.

The standards cover workspace, session, knowledge, git, tools, approvals, handoff and
recovery. They are mandatory documents, not optional skills. knowledge.md defines the
fixed headings and evidence rules for PROJECT, STATE and topic pages. The agent owns
routine knowledge upkeep. Jan reviews decisions and approvals, not routine edits.
memini remains supplementary searchable recall in homelab/<project>, inherited by
children. It must not be the only copy of recovery-critical facts.

Agents may edit, test and commit locally. Pushes, merges, PR creation, deployments,
cluster changes and every HA write require Jan. There are no light, scene or reload
exceptions. Read-only template evaluation is not a live-control exception. The parent
explains the exact call and reason, then uses the interactive guard. Children block
and report back. Memory, old handoffs and children cannot grant approval. Print, JSON
and RPC cannot approve. The command-pattern guard catches mistakes, not arbitrary
scripts or API bypasses. Policy applies through every tool.

Keep model settings and platform instructions out of deployable repositories such
as Home Assistant. Upstream repository instructions may be read but cannot weaken
central approvals. Jan's prose uses minimal punctuation, no em or en dashes, no
semicolons and no ellipses.

## Context injection

home/dot_pi/private_agent/local/project-context.ts is registered in the Pi settings for
both renders but returns immediately when PI_PROJECT is unset, so the Mac is unaffected.
It validates PI_PROJECT_DIR as ~/Development/<PI_PROJECT>, requires the project in
~/.config/agents/projects.json and reads the ordered manifest. It builds one message
from the standards, notes/PROJECT.md and notes/STATE.md and returns it from
before_agent_start. The bridge forwards that custom message as literal prompt text,
while project context files and system prompt changes are cached from its first
request, so injection must not rely on those routes.

The message is rebuilt before a turn when any loaded file's content hash changes, and
again after a compaction or a new, resumed or forked session. Each message carries the
standards version, the combined standards digest and a context revision, and states
that it supersedes any earlier context message. Children inherit PI_PROJECT and
PI_PROJECT_DIR and receive the same context.

Content input is the registry, the standards manifest and files, notes/PROJECT.md and
notes/STATE.md. The knowledge index is in PROJECT.md, and detailed topic pages are read
as needed rather than injected. The budget is 24 KiB of UTF-8 for the standards plus
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
<model>:<thinking>, exporting PI_PROJECT, PI_PROJECT_DIR and MEMINI_NAMESPACE.
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
Runtime .agent state must remain outside workspace Git. There is no backup
coordination protocol.

## Deferred home migration and recovery

Do not treat agent adopt home as a migration. Preserve the entire live workspace,
uncommitted STATE edits, sessions, raw history, refs and worktree inventory first.
Establish hourly backup and an isolated restore drill before removing the existing
GitHub safety copy. At an agreed idle boundary, stop the runner, register the existing
home-assistant checkout in place without recloning or resetting, and keep ha-inventory
as ordinary tracked content.

Reconcile dated evidence into PROJECT, STATE and topic pages. Preserve tighter project
constraints and explicitly retire all old HA write exceptions. Remove workspace
AGENTS.md from active instruction discovery. Untrack .agent runtime files without
deleting them. Start a deliberate new generation with tested context loading and
updated rotation. Verify approvals without a live deployment. Archive the old GitHub
wrapper only after Jan approves.

Later backup must include complete workspaces, Git and submodule stores, uncommitted
and untracked work, local-only commits, .worktrees, runtime generation and handoffs,
Pi sessions, raw history, external platform records, effective registry and standards,
and the chezmoi source checkout. Exclude external credential caches, runtime locks and
narrowly reviewed reproducible caches. Do not blanket-exclude dependency lockfiles or
.env filenames. Treat sessions and untracked content as sensitive even when encrypted.

Restricted SFTP access, the BigMouth subtree, NAS host-key pinning, snapshot policy
and independent stale-backup monitoring need separately approved shared-system work.
A fresh-host restore runbook and measured recovery drill remain later deliverables.
