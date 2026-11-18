# Projects on aether

aether is Jan's always-on personal development machine, an Oracle ARM VM running Ubuntu
26.04.1 as `ubuntu`. Jan talks to each project's Pi in a Rex tab from the Mac app, connected
to aether's Rex login server. Work repos stay off aether. The Mac stops hosting long-lived
personal Pi sessions as each project migrates.

## Registry and layout

`home/.chezmoidata/projects.yaml` is the single source of truth. Chezmoi renders its defaults
and project map to `~/.config/agents/projects.json` on Linux and Mac. Tailor common standards
per project in this registry, not in launcher code.

Defaults are `model: claude-bridge/claude-opus-5-5`, `thinking: high`,
`meminiPrefix: homelab` and rotation thresholds `sizeMB: 100`, `compactions: 5`, `days: 30`.
A project has a GitHub `workspace` repo, `repos` entries with `name` and clone `url`, a
`secrets` map of environment names to `op://` references, and an optional `apt` list. It can
override model, thinking, meminiPrefix and individual rotation thresholds. Names are simple
single directory components. Reserve `up` and `ls` for launcher commands.

The first project is `home`, workspace `janpuc/home-workspace`, containing
`home-assistant` from `https://github.com/janpuc/home-assistant.git`.
`HA_TOKEN` comes from `op://Kubernetes/hass-mcp/HASS_MCP_TOKEN`. Plain configuration such as
`HA_URL=https://hass.janpuc.com` belongs in the workspace's mise.toml, not the registry.

```text
~/Development/<project>/          private workspace git repo and Pi cwd
├── AGENTS.md                     project map, repo relationships and stable knowledge
├── notes/STATE.md                milestones, current state and open threads
├── plans/                        material outside the code repos
├── <repo>/                       independent git repo with its own AGENTS.md
├── .worktrees/                   task worktrees
└── .agent/                       local conversation rotation state
    ├── generation                positive integer, initially 1
    ├── handoff-<N>.md            initial prompt for generation N
    ├── rotate-requested          committed request containing the next generation number
    ├── launch.lock               serializes launcher calls
    └── run.lock                  held while the generation loop is alive
```

The workspace repo versions AGENTS.md, notes and plans. Its `.gitignore` must exclude the
nested repos, `.worktrees/`, `.agent/` and any local secrets. Git always names its target
with `git -C <repo>`. Never `git add -A` at the workspace root.
GitHub sync is through Jan-approved pushes. BigMouth backup comes in a later change.

Single-repo projects use the same wrapper. Later groupings are decided as they migrate:
`home` may also hold ha-inventory, `renplay` its code and plans, `homelab` infrastructure
repos, and `pi` Jan's Pi packages.

## Launcher and Rex

On Linux:

- `agent <project>` clones a missing workspace with `gh repo clone`, then missing nested
  repos with git. It looks up the exact project label in `rex ls --json` and tab labels in
  `rex session inspect --json`. It creates only missing resources.
- Each project has one Rex session labelled `<project>`, with tabs `pi` and `shell`, both
  initially at the project root. `pi` runs `agent-run <project>` with `--keep-open`.
- If the Pi runner has exited, the launcher replaces the stopped terminal block within the
  existing `pi` tab. Rex currently has no terminal restart method. An idle shell can also be
  replaced, but a live unmanaged program or a tab with multiple panes is left alone with an
  error. Unrelated tabs and sessions are never closed.
- `agent up` performs the same reconciliation for every registered project. Use it after a
  reboot or Rex upgrade. Rex restores tabs, cwd and scrollback, not programs.
- `agent ls` prints folder presence, Rex session ID, Pi runner liveness and generation for
  each project. The runner lock includes startup and rotation, not just model execution.
- If exactly one Rex app is connected, the launcher selects the session with
  `rex -C CLIENT do session.select session_id=ID`. With several apps it does not choose for
  Jan. Client Remote Control must be enabled by Jan.

`agent` is a fish function. `~/.local/bin/agent-run` implements reconciliation and the
long-lived generation loop. Both are Linux-only and explicitly allowlisted. The Mac has
the registry but no local project launcher. To inspect or select aether sessions from the
Mac, use `rex -S aether ls --json`, `rex -S aether client ls` and the client action above
with `-S aether` before the command.

`agent-run` reads or initializes `.agent/generation` and starts the existing Pi wrapper
`~/.pi/agent/local/bin/pi` with
`--session-id <project>-<N> --model <model>:<thinking>`.
It exports `PI_PROJECT`, `PI_PROJECT_DIR` and `MEMINI_NAMESPACE=<prefix>/<project>`.
Secrets are loaded from the generated project env file. Missing secrets fail startup with
an error rather than silently starting an unauthenticated agent.

If `.agent/handoff-<N>.md` exists and Pi has no session file for this ID in the current
workspace, it becomes the initial user message. Ordinary restarts resume the existing
conversation without replaying the handoff. When Pi exits, the runner loops only if
`.agent/rotate-requested` names the current generation plus one and that handoff exists.
It atomically advances generation, removes the request and starts the next Pi. Otherwise it
exits, reporting invalid requests without discarding them. On restart it recovers a pending
request, including a generation commit interrupted before request removal.

## Tools in three layers

1. Dotfiles provide base tools: apt basics including jq, Docker CE and its compose/buildx
   plugins, mise, yq, ripgrep, uv, node, Pi, gh, 1Password CLI and common shell tools.
   Project `apt` lists extend this system layer. Docker uses its official deb822 apt repo
   for the running Ubuntu codename, never an implicit fallback. Docker publishes resolute
   and the required arm64 packages. `ubuntu` joins the docker group, effective on new login.
   Docker group membership is root-equivalent.
2. The workspace repo's `mise.toml` defines project-wide tool versions, environment and
   tasks. It loads `~/.local/state/ai/projects/<project>.env` with `[env] _.file`, and keeps
   plain values such as HA_URL in git.
3. Each nested repo may refine tools and tasks with its own `mise.toml`.

Mise trusts configs under `~/Development` on Linux. Pi trusts
`/home/ubuntu/Development` through an additive `trust.json` modifier, preserving other
trust decisions. This is not `defaultProjectTrust: always`.

The runner prepends `${MISE_DATA_DIR:-~/.local/share/mise}/shims` to Pi's PATH, equivalent
to `mise activate bash --shims`. Mise's shims documentation says each invocation resolves
its own cwd's tools and environment. The runner loads workspace environment once with
`mise env --json`, so apt tools like curl receive HA_URL as well as the project secrets.
The project-only branch of the Pi wrapper resolves absolute node and Pi paths with
`mise which` and launches them directly, preserving shim-first PATH. Launching Pi through
its own shim or `mise exec pi` would prepend real tool directories again and freeze paths
from the workspace for commands later run in nested repos. Shims load nested mise env
only when a shimmed command is invoked. For an apt tool needing a nested repo's env,
use `mise exec -- <command>`. A shim cannot update its parent bash environment after a `cd`.

Linux `ai-sync` keeps the shared AI credential cache unchanged and also writes each
project's secrets through the same 1Password service account. Project env files are 0600
in a 0700 directory, contain quoted single-line `KEY=value` assignments with dollars escaped
against dotenv expansion, and are atomically replaced only after all the project's secrets are fetched.
A failed read preserves that project's old file and returns an error. Re-run after rotation.
Never commit these files or put token values in the registry.

## One consistent agent, with approvals

Pi runs through pi-claude-bridge using Jan's subscription. Model and thinking are command
line options, not settings committed inside the code repos. Pi loads AGENTS.md from cwd
and parents, so the project map instructs it to read each repo's AGENTS.md before working
there. Common agent/model tables remain shared in the OS-aware global AGENTS.md.

The Linux agent does the work itself and delegates only bulk reading or parallel bounded
jobs. Children open as tabs in this Rex session with no remote machines. Linux settings
remove `subagents.machines`. Mac remote placement behaviour is unchanged.

The agent edits, tests and commits on its own. Pushes, merges, PR creation, cluster changes
and HA service calls wait for Jan. It explains what and why in one line before the call.
`agent-guard-ask.ts` confirms matching bash calls in Jan's TUI, allowing yes and blocking
no. Print, JSON and RPC cannot approve. Children keep `agent-guard-child.ts` and block the
same calls outright. Child environment detection is identical in both adapters.

The shared rules include git push, GitHub writes, cluster/node/config changes and
curl/wget/http writes to `hass.janpuc.com/api/` or `$HA_URL/api/`. POST, PUT, PATCH, DELETE
and data-bearing requests require approval. `/api/template` is the read-only render
exception. GET reads pass. This command-pattern guard catches mistakes, not arbitrary
scripts or malicious bypasses. The instructions still apply to every tool and API.

## Context, memory and rotation

Opus 5.5 has a 1M window. Linux sets exactly one `compaction.modelOverrides` entry for
`claude-bridge/claude-opus-5-5`, with `reserveTokens: 750000` and
`keepRecentTokens: 60000`, triggering near 250K. Other models keep normal defaults.
Cache warming stays at Pi's default. Idle agents do not make normal work requests, though
Pi may choose economical cache refreshes.

Memory has four complementary layers:

1. Project and repo AGENTS.md hold stable knowledge, reviewed by Jan and kept in git.
2. memini holds durable facts in `homelab/<project>`, also inherited by children. The Linux
   fish namespace hook maps the first component under `~/Development` to this namespace.
   At `~/Development` itself its existing prefix behaviour remains. Mac behaviour is unchanged.
3. `notes/STATE.md` records milestones, current work, open threads and next steps. After
   every compaction, re-read it before continuing. After editing an AGENTS.md ask Jan for
   `/reload` then `/compact`.
4. The conversation is compacted normally and eventually rotated into a fresh generation.
   Old session files remain available for history searches.

`project-rotate.ts` is active only in a project parent session. It tracks session JSONL
size, compactions including existing CompactionEntry entries on resume, and header age.
Any threshold makes the status say `rotate due`. Size/age are refreshed every minute and
at agent boundaries. At the next final idle boundary it asks `Rotate now?`, only once per
session start. Pi 1.5 calls this `agent_settled`, because `agent_end` can precede retries,
compaction recovery or queued messages. A no leaves the status and allows manual rotation.

`/rotate [note]` or a yes performs these steps:

1. Send a user message asking the agent to update notes/STATE.md, update the project
   AGENTS.md if stable knowledge changed, store durable facts with memory_remember, and
   commit the workspace repo with explicit paths and `git -C <project dir>`. Never push.
   Wait until this run settles successfully with its completion marker. If it aborts or
   needs Jan, keep the current generation and allow retry with `/rotate`.
2. Use the current compacted conversation plus notes/STATE.md to generate a self-contained
   handoff prompt with open threads, decisions, files and next steps, modeled on Pi's
   handoff example. A model or filesystem failure leaves the current session alive.
3. Write `.agent/handoff-<N+1>.md`, then atomically write the next generation number to
   `.agent/rotate-requested` and request graceful Pi shutdown. The extension never advances
   `.agent/generation`. If the request write fails, only a stray handoff remains for retry
   to overwrite. After Pi exits, the runner consumes the request and advances generation.
   It sends the handoff only if the next session does not already exist.

Rotation does not delete old sessions. Linux and macOS chezmoi cleanup removes only the retired
`~/.pi/agent/local/pocket.ts`, `pocket.test.ts` and `pocket-api.md` files.

## Onboarding checklist

1. Check prerequisites: dotfiles DNS change available, `gh auth status` works as ubuntu,
   Rex app can reach aether's login server, and Oracle does not expose SSH :22 publicly.
2. On Mac, push approved unpushed commits and commit or stash local changes. Inventory
   non-git folders to migrate.
3. Inventory tools before cloning: versions, CLIs, repo tasks, system packages, container
   needs, environment names and credential references. Assign each to base dotfiles,
   workspace mise.toml or repo mise.toml. Grant the read-only service account access to
   the referenced 1Password items.
4. Create the private workspace repo with project AGENTS.md, notes/STATE.md, a mise.toml
   and `.gitignore` excluding nested repos, .agent, .worktrees and secrets. Add the project
   to projects.yaml with clone URLs and credential references. Jan reviews the map.
5. Collect relevant Mac Pi history, Pocket's archived history
   (`~/Archive/aether/pi-pocket-retired-2026-11-18.tar.gz`, pocket.sqlite) and memini.
   Consolidate old per-repo namespaces and pins into `homelab/<project>` and check recall.
   Compile a first handoff prompt with open threads, recent decisions and known problems.
6. Copy raw session history to `~/.local/share/agent-history/<project>/` for grep. Do not
   import it as Pi sessions with stale Mac cwd paths.
7. Apply the reviewed dotfiles on aether, start a new login for Docker group membership,
   run `ai-sync`, then `agent <project>`. In the workspace run `mise install` and verify
   its env file loads. Send the initial migration handoff or install handoff-1.md before
   first launch. Verify one real task, a guarded call, `agent up` idempotency and `/rotate`.
8. Archive the Mac sessions and retire their long-lived processes. Keep Mac clones only
   for intentional sync. BigMouth backups are a separate follow-up.

## Not now

Pi Durable is a library for agent apps, not the terminal Pi runtime. Its extension format
would not load memini, claude-bridge and subagents as used here. Revisit for phone steering.
