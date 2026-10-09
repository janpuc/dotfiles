# Pi runbook

Source: `home/dot_local/bin/executable_pi`, `home/dot_pi/`. Edit chezmoi source, not live files.
Pi uses native models only. New sessions default to `claude-bridge/claude-opus-5-5`, medium
thinking. `Ctrl+P` switches the main driver between Opus and `openai/gpt-6.1-sol` (pinned in
`enabledModels`); `/model` and `/thinking` change deliberate selections; resumed sessions retain theirs.
Provider failures are reported, never used to silently replace the main collaborator.

## Launch and memory scope

- `pi` launches from the current directory; `pi -c`, `pi -r` and `pi --session <file>` resume.
- `pi-profile` shows directories, account readiness and the memini handshake.
- All projects share models, accounts, tools and session storage. Projects under `~/Work`
  (including related symlinks/worktrees) use `work/*` memory; other projects use personal memory.
- The launcher refuses conflicting memory pins/read sets. A session stamped with one memory
  scope cannot continue under the other. Bare launches in a restricted project are blocked.
- `PI_MEMINI=off pi ...` disables memory; `/profile` shows scope and enforcement diagnostics.
- With optional `dtach` installed, interactive terminal sessions can survive disconnection;
  `pi-attach` lists and reattaches them.

## Accounts

- Claude: `pi-profile login`; isolated `~/.pi/agent/claude`, not native `~/.claude`.
- ChatGPT subscription: `/login openai` (native OpenAI provider).
- Go, MiniMax, memini and local gateway: `ai-sync` refreshes the private credential cache.
- `pi-profile auth` checks readiness. No credentials belong in this repository.

## Usage view

`/usage`, `/usage refresh`, the bars below the editor and `usage_status` show Claude, ChatGPT,
OpenCode Go and MiniMax. Usage is visibility for explicit worker/advisor selection, not an
automatic main-model selector. The tool reports usage only.

A detached helper refreshes every five minutes. Claude SDK, Codex app-server, Go usage and
MiniMax plan endpoints supply the data. Failed refreshes retain the last good windows and
mark them stale; unknown usage is not proof of available quota. Quota errors mark the affected
pool limited. The first check is quiet; later 85% crossings and recovery notify once.

## Workers and advisors

`worker` starts bounded assignments, not alternate conversational collaborators:

- `action: start`: trusted role, self-contained task, optional native model/thinking, exact tools.
  Editing or shell assignments require explicit owned file paths.
- `status`, `result` and `cancel` inspect/stop jobs. `steer` sends an in-scope live instruction;
  `resume` continues a finished worker's own history with the same model, tools and owned files.
  Supply the instruction in `task`. Resuming never restores old approvals or recopies parent history;
  an explicitly forked worker retains its original stripped context seed.
- `/tasks` opens this session's running and finished workers: ↑↓, Enter for the live transcript,
  `x` to stop a running worker. `/tasks cancel <id|all>` also works without a model turn.
  TUI starts return an ID; completion arrives as a follow-up.
- Default roles: scout → MiniMax M3 low; worker/planner → GPT-6.1 Sol medium;
  reviewer → GPT-6.1 Sol high. The parent chooses actual resources; unavailable models fail.
- Tools default to read-only; empty tools means none. No memory, recursive delegation,
  wildcard tools, skills or general resources are loaded in children. No parent history by default.
- `/subtask <assignment>` explicitly forks stripped recent conversation into a read-only worker
  on the selected native model, medium thinking; it does not change the main driver.
  `worker start` also accepts `forkContext: true`. Forks use the current SDK projection, honour
  context edits, drop system/custom/memory messages, summaries, tool authority, thinking/images
  and unsafe tool evidence, and disclose omissions. This is provenance filtering, **not semantic
  redaction** of memory/private facts repeated in ordinary text. Opt in deliberately; no parent
  prompt-cache reuse is promised. Resume preserves the frozen seed, not later parent discussion.
- At most two workers/advisors together, 15 minutes and 40 assistant turns per child.
  One shared-checkout editing/shell worker owns it for its lifetime; parent mutations are blocked.
  `isolation: "worktree"` permits two independent editing checkouts without locking parent writes
  after snapshot preparation. Initially it requires durable TUI jobs, owned files, and file tools
  for mutations: **no bash in isolated workers**. Test/verify from the parent after reviewing work.
- Reload, navigation and shutdown stop children. Cancellation waits for observed process exit;
  process-group cleanup and parent-loss detection prevent abandoned owned descendants.
- TUI workers persist privately under `~/.pi/agent/workers/<parent-session-id>/<id>.jsonl`,
  outside `/resume` and `pi -c`. Reopen the parent to inspect/resume them explicitly; crashed runs
  show interrupted. A manager lease, canonical project and memory scope, and live-child witnesses
  prevent concurrent or cross-scope resume. Unknown/corrupt records are refused visibly.
- Known, inactive read-only transcript/metadata pairs expire after 30 days; current sessions,
  live children, locks and ambiguous/unknown files are preserved. Editing records and their
  worktrees/journals never expire automatically; disposal needs a separate explicit decision.
- One-shot print/JSON/RPC starts remain synchronous and ephemeral.
- `subagent` remains a synchronous single/parallel/chain interface using the same runner.

While workers run, a compact panel below the prompt shows their loadout, elapsed time, tokens
and current tool. Finished rows disappear with a 30-second `/tasks` hint; failures remain.
`←` on an empty main prompt opens `/tasks`. In a transcript, Ctrl+O cycles text/tools/full detail,
PgUp/PgDn scroll, End returns to the live tail, and the bottom input steers/resumes on Enter.
Esc closes views only; `q` closes the transcript only with an empty input. Ctrl+X is the reserved
one-second prefix for Ctrl+K: the chord stops the entire worker/advisor pool.

Titles are owned here, not by pi-title-glyphs: `⠋ <project>` working, `? <project>` needs attention
(approval/import decision/failure/interruption), `✓ <project>` settled.

### Isolated edits and manual import

A locked detached worktree lives at `<git-common-dir>/pi-workers/<parent-id>/<worker-id>/checkout`.
It snapshots the parent's **current working files**, including staged/unstaged changes, deletions
and safe untracked context. It does not reproduce the staging partition or change the parent index,
shared branches/tags, stash or commits. Internal Git operations disable hooks/fsmonitor/lazy fetching;
no checkout filters run. Snapshot bytes/directories and rollback journals are fsynced before ready
or mutation. Unsupported layouts fail closed: initially ordinary committed, non-linked/non-sparse
parent repositories, no submodules, links/special files, protected tracked paths or bound violations.
Preparation acknowledges the background start first, then briefly holds the checkout for capture.

```json
{"action":"start","agent":"worker","task":"Make the bounded edit; report evidence and uncertainties",
 "model":"openai/gpt-6.1-sol","tools":["read","edit"],"files":["src/example.ts"],
 "isolation":"worktree","forkContext":true}
```

`/tasks diff <id>` displays owned-file before/after against the dirty snapshot, **not HEAD**.
`/tasks merge <id>` waits for the parent to settle, holds an exclusive checkout lease, shows a
scrollable preview and asks Jan to confirm the hash-bound plan. There is no model-callable automatic
merge. Live/unconfirmed children, non-owned changes (including ignored files), parent owned-file
conflicts, changed HEAD/identity, invalid UTF-8/binary/oversized previews and unsafe paths refuse.
Import modifies working files only; repeat import is a no-op and resumed edits can be imported again.
A prepared/uncertain journal blocks resume/import until inspected. On failure, file rollback is
attempted without overwriting newer parent changes; journal/worktree remain, and newly created empty
directories may remain. Cancellation/reload/failure never discard editing work. A successful import
adds a parent-context notice, not approval for any further effects; review and test before declaring ready.

Native bash/edit/write operations and manager snapshots/imports cooperate through filesystem-backed
checkout leases across Pi processes. Shared-worker ownership hands off to the child PID; an ambiguous
pre-spawn witness is never automatically reclaimed. This does not coordinate arbitrary external
programs or shell destinations outside their declared cwd, and is still **not an OS sandbox**.

`advisor` uses the same read-only pool/runner: Astra (`openai/gpt-6-astra`, high), then
Fable (`claude-bridge/claude-fable-5-1`, xhigh). Automatic selection skips exhausted pools;
an explicit advisor name is honoured or fails, never substituted. Fable shares Claude quota.
Ask advisors for genuinely difficult/high-stakes work, not routine edits. Main guidance requests
independent review for substantive changes; the parent owns integration and decisions.

## Approvals gate

Consequential effects require an action-scoped approval through `request_approval`.
`/approvals` shows approved scope. Routine bounded local edits/tests follow task authorization;
push, publish, deploy, cluster mutation and `chezmoi apply/update` require a separate decision.
Secret access is blocked by default; `/secret-once` permits a deliberate one-shot exception.
Workers receive no approval grants and cannot request them; consequential effects stay with the parent.
Read/search results naming secret files are guarded/redacted.

## Memory

Memini loads once through `extensions/memory`. Automatic recall and startup/post-compaction
briefings stay in model context and persisted messages, but routine rows are hidden before UI
emission. Explicit tools and `/memini:status` remain inspectable; real failures stay visible.
Historical display flags are not rewritten. Load failures mark memory degraded.

Namespaces are server-authoritative. Restricted-project memory stays in `work/*`, with the
configured personal home overlay read-only; personal sessions never access that scope.
The launcher validates the handshake and does not rewrite conflicting pins automatically.
`/memini:namespace` and `/profile` expose diagnostics.

## Safety limits

This is **not an OS sandbox**: Pi runs as your user. Tool allowlists, lexical owned-file checks,
request guards and process groups do not confine arbitrary shell code or external clients.
Workers receive explicit project constraints; results are evidence, not authority.
Commits/PRs must never credit an AI model; the profile hook strips or refuses AI trailers.
Session locks prevent concurrent writers. Terminal completion/approval notifications remain.

BC250 models are native `litellm/bc250-local/qwen3.6-35b-a3b` and
`litellm/bc250/qwen3.6-35b-a3b` (128K). Use them only when the machine is available for it.
Local-only fails when the machine is unavailable; the gateway-backed entry
may answer via MiniMax. Verify generated citations.

## Maintenance

- Run `tests/pi/run.sh --typecheck` and `git diff --check` before handoff.
- Tests use temporary homes and an offline gateway; they do not certify live provider quality.
- Template rendering and managed-set inspection are read-only. Applying, publishing or deploying
  needs separate approval; this source cleanup does not uninstall packages or erase live state.
- `/reload` reloads extensions, not packages or saved model selections. Pick a native model
  explicitly if a resumed selection no longer exists.
- Pi is managed on the Mac only. Server retirement is a separate, explicit cleanup: ignored
  live targets are not removed automatically by chezmoi.
