# Pi: Work / Personal runbook

[Pi](https://pi.dev) (`pi-coding-agent`, Homebrew) with two isolated profiles, usage-aware virtual models, a MiniMax
router, subagents, an advisor, and memini.
Sources live in the dotfiles repo: `home/dot_local/bin/executable_pi` (launcher), `home/dot_pi/` (config),
`home/dot_config/fish/functions/pi.fish`, tests in `tests/pi/`.

## Launch

| Command | Profile |
|---|---|
| `pi` | Work under `~/Work` (also via symlinks, case variants, or a worktree whose repo lives there); Personal elsewhere |
| `piw` | Work from anywhere (`work/scratch` memory outside a repo) |
| `piw --personal-models -c` | **Work override**: same Work session and `work/*` memory, but on the Personal models (enterprise credits ran out). Explicit per launch, announced, never automatic |
| `pi -c` / `pi -r` / `pi --session <file>` | continue / pick / open a session — only within the launch's profile |
| `pi-profile [--work] [--personal-models]` | show what a launch here would do: profile, reason, dirs, memory namespace, memini handshake |
| `pi-attach [<n>\|<id>\|--list]` | aether: get back to an interactive Pi that kept running after its terminal went away (below) |

Every launch recomputes the profile from the canonical directory and git common dir; nothing depends on fish's
PWD hooks. A process started from a Work session stays Work. The launcher `exec`s the real `pi`, so arguments, exit
status, signals and resume hints are unchanged. Refusals exit 78 before Pi starts.

## One-time logins

| Account | Command | Stored in |
|---|---|---|
| Personal Claude (Max) for `pi-claude-bridge` | `pi-profile login` → pick the personal subscription | `~/.pi/agent/claude` + Keychain `Claude Code-credentials-<sha256(dir)[:8]>` |
| Enterprise Claude for Work | `pi-profile --work login` → pick the enterprise organisation | `~/.pi/profiles/work/agent/claude` + its own Keychain item |
| ChatGPT plan (Personal) | `pi`, then `/login openai` → **Sign in with ChatGPT** (`openai-codex` is Pi's legacy provider) | `~/.pi/agent/auth.json` (OAuth) |
| OpenCode Go, MiniMax, LiteLLM, memini keys | `ai-sync` (1Password → `~/.local/state/ai/credentials.fish`); the subscription keys are cached as `PI_OPENCODE_API_KEY` / `PI_MINIMAX_API_KEY` and only Personal Pi sees them as `OPENCODE_API_KEY` / `MINIMAX_API_KEY` | env only |

Check with `pi-profile auth` and `pi-profile --work auth`. The native `claude` login (`~/.claude`) is not used or
touched. The launcher refuses to start if the Work Claude dir holds a personal plan or both dirs hold the same org.

## Model sources

Native Pi providers for every subscription: `claude-bridge` (Claude via the Agent SDK), `openai` (ChatGPT plan through
Sign in with ChatGPT; it spends the same Codex 5-hour and weekly pool as the Codex CLI, plus any per-app cap set in
ChatGPT → Settings → Usage), `opencode-go` and `minimax`. LiteLLM is only used for the BC250: `bc250-local/qwen…`
(local only) and `bc250/qwen…` (LiteLLM falls back to MiniMax M3 when the box is off).

## Virtual models (`~/.pi/shared/routing.json`)

`auto` is the Personal startup default; Ctrl+P cycles `auto → daily → deep → fast`. On each new prompt the router
takes the first target that is usable and inside its usage budget; tool loops and compaction stay on the model that
answered last.

| | Personal | Work (enterprise seat) |
|---|---|---|
| `auto` | OpenAI Decisions (MiniMax M3 as fallback) picks `fast` / `daily` / `deep` per prompt (below) | — (deterministic) |
| `daily` | Opus 5.5 medium *(while the Claude week is on pace, ≤ 85%)* → Sonnet 5.5 medium → GPT-6.1 Sol medium → GLM-5.3 high *(Go ≤ 80%)* → MiniMax M3 medium | Sonnet 5.5 medium *(spend ≤ 95%)* → Haiku 4.5 |
| `deep` | Opus 5.5 high → GPT-6.1 Sol xhigh → GLM-5.3 high → Qwen3.8 Max xhigh | Opus 5.5 high *(spend ≤ 90%)* → Sonnet 5.5 high |
| `fast` | MiniMax M3 low → DeepSeek V4.1 Flash low → GPT-6 Luna low | Haiku 4.5 → Sonnet 5.5 low |
| `local` | BC250 Qwen 3.6 35B, local only, no fallback | — |
| `qwen` | BC250 Qwen via LiteLLM, MiniMax M3 when the box is off | — |

Why (review of 2026-10-07; sources: Vals Terminal-Bench 4.0, Artificial Analysis, vendor plan pages):
- **Claude Max 5x**: Opus 5.5 leads TB4 (65.2); Sonnet 5.5 is a point behind at about half the plan usage and faster,
  so `daily` drops to it whenever the week runs ahead of pace. Fable has its own weekly cap and is kept for the advisor.
- **ChatGPT Plus** (small pool: GPT-6 Astra 5–45 messages per 5 h, Sol 15–150, Luna 350–3,000): GPT-6.1 Sol gives ~90% of
  Astra's TB4 at a fifth of the credits, so it is the Codex workhorse; Astra is advisor-only; Luna is nearly free.
- **OpenCode Go** ($10, one dollar-metered pool, 5 h = 20% / week = 50% / month = 100%): GLM-5.3 is the strongest open
  model (text only, pricey per request), Qwen3.8 Max covers images, DeepSeek V4.1 Flash is the cheapest and fastest.
- **MiniMax** (near-unlimited plan): M3 is the router, `fast`'s first choice and the last stop in `daily`.
- **Work**: the seat is spend-metered with a small monthly allowance, so Sonnet does daily work, Opus is for `deep`,
  and both step down as spend grows; when it is used up the error points at `piw --personal-models -c`.

**Usage budgets.** `maxUsed` skips a target on a new prompt once its pool's busiest window is that full (default 90%);
`paced` also skips it while a window runs more than 10 points ahead of its elapsed time. At 97%, or when the plan
reports its limit or a request fails with one, the pool is skipped outright until it resets. Budgets steer and never
block: if every target is over budget the first usable one runs. Near a threshold the model in use keeps its place
until 5 points over, and a higher-ranked target needs to be 5 under to take over.

**Long conversations stay put.** Every provider's prompt cache is per model, so moving a long conversation to another
model for budget or pace reasons costs more than it saves. Above `usage.stickyAboveTokens` (30,000 estimated tokens,
the same size at which `auto` stops downgrading a tier) a new prompt stays on the model that answered last, even past
its `maxUsed` or pace, and is not pulled back up to a higher-ranked model that has since recovered. It still moves when
the model is exhausted or limited, has no login, cannot take the prompt's images or is not allowed in the profile,
when a failure fallback for another target is active, and on any failure (retries, tool loops and compaction are
unchanged). A fallback that has answered is kept after its sticky timer ends, until compaction brings the conversation
under the threshold. The trade-off is that a pool can run to its 97% cutoff sooner, which matters most for Work's small
spend allowance. It keeps the model, not the effort: `auto` moving `daily` to `deep` on the same model still changes
the thinking level, which invalidates the message cache. The size is a rough estimate (characters / 4), not a
measurement of a warm cache.

**auto.** For each new prompt (not short follow-ups like "yes"), a classifier sees the message, a snippet of the last
answer and the conversation size, and picks `fast`, `daily` or `deep`; it judges how hard the thinking is, not how
long the answer should be. It is the OpenAI Decisions API (`gpt-6-luna`, one `choice` question over the tiers, $0.10
per 1M input tokens, billed to an OpenAI API account) when `PI_OPENAI_API_KEY` is set (via `ai-sync`; Personal only,
never exported as `OPENAI_API_KEY`). It returns a probability per tier: below 50% confidence the stronger of the two
likeliest tiers wins, and the footer shows the percentage as the reason. Without the key, or when Decisions fails or
takes over 4 s, MiniMax M3 answers instead. Upgrades apply at once; in a conversation over ~30k tokens a downgrade is
ignored to keep the prompt cache. If both classifiers fail, the current tier stays (`daily` to start). It is a model call, so a
borderline prompt can occasionally land a tier low — pick `deep` explicitly when it matters.

**Failures.** Bounded and in-profile, same billing class only. Transient errors retry the same target once. Plan
limits and missing logins skip the rest of that provider; an unavailable model moves to the next target. LiteLLM
failures are not retried again, because it already retries 3× and fails over itself. A failure fallback sticks for
20 minutes. Work never falls back to personal models.

## Usage tracking

| Pool | Source (credential stays with its client) | Windows |
|---|---|---|
| Claude (Personal Max / Work enterprise) | Claude Agent SDK's `/usage` data, per profile Claude login (experimental SDK API) | 5 h, week, Fable week / monthly spend |
| ChatGPT | `codex app-server` → `account/rateLimits/read` (the Codex CLI's own login) | 5 h, week |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` with Pi's key | 5 h, week, month |
| MiniMax | `GET api.minimax.io/v1/token_plan/remains` with Pi's key | 5 h, week |

A detached helper (`usage-refresh.ts`) refreshes `<agent-dir>/usage.json` every 5 minutes while Pi runs, after a turn on
a pool, and on start; routing only reads the file, so it never waits on the network. Data older than 30 minutes counts
as unknown (no preference), and a failed refresh keeps the last good numbers. See it with `/usage` (a panel with every
window and reset time; `/usage refresh` re-reads now) or the line under the editor: one bar per subscription for
its busiest window, coloured by how full it is, `▸` on the one in use, `!` for stale or failed
data, `×` while limited, a single `usage ok` while everything is under 30%. Pi notifies once when a window passes 85%
and when a limited subscription is usable again. Agents read it with the `usage_status`
tool before picking a model, subagent or advisor. ChatGPT usage needs the Codex CLI logged into the same ChatGPT
account.

## Footer

The profile extension replaces Pi's footer (no token counts or cost; these are subscriptions):

```
 personal  ~/Development/home-ops ⎇ main                         ● mem homelab/home-ops
auto → daily → claude-opus-5-5 · medium  multi-file refactor        ctx ▰▰▰▱▱▱▱▱ 34% of 200k
```

Line 1: profile badge (green personal, yellow work, red work on personal models or blocked), directory, branch, session
name, and the memini state with its namespace (green ok, yellow degraded, red conflict, dim off). Line 2: the selected
model and, in bold, the model actually answering: the request in flight, otherwise the one behind the latest reply in
the session, so it survives `/reload` and resumed sessions (for `auto` also the tier and the classifier's reason). Then
the thinking level in its theme colour and the context gauge. Statuses from other extensions get a third line only when there are any. On
a narrow terminal the right-hand parts shorten first, then the left is cut.

## Subagents and the advisor

- **Subagents:** Pi's official subagent extension, vendored in `extensions/subagent`. Agents live in `agents/`
  (linked into each profile): `scout` (fast, read + bash), `planner` (deep, read-only), `worker` (daily, all tools)
  and `reviewer` (deep, read + bash). Workflow prompts: `/implement`, `/scout-and-plan`, `/implement-and-review`.
  Each subagent is a separate `pi` in the same profile and policy, without Memini capture.
- **Advisor:** the `advisor` tool asks a stronger model that isn't in `/model` for a read-only second opinion. Say
  "ask fable", "check with astra" or "ask the advisor", and the agent also consults it on genuinely hard problems.
  Personal: `astra` (GPT-6 Astra, high) then `fable` (Claude Fable 5.1, xhigh); with none named, the first whose pool
  is under 90% is used, and an advisor whose pool is used up is refused with the alternative. Work: `fable` (high) on
  the enterprise seat only — it is the most expensive model there; astra is refused, with the override as the hint.
  Advisors and order: `routing.json` → `advisors`.

## Tool policy (Personal)

Work mirrors the organisation's Claude Code policy (Isolation, below). Personal has its own, in
`~/.pi/shared/personal-policy.json` (Claude Code rule syntax, same engine): anything no rule covers runs. Pi asks before
`git push`, PR merges and releases, cluster changes (`kubectl apply/delete/patch/...`, `flux reconcile/suspend`,
`talosctl` upgrades/reboots, `helm`, `terraform/tofu apply`), `sudo`, `chezmoi apply/update`, `op` and `rm -rf`, and
before editing home-ops. It never reads the credential caches, the 1Password token, SSH keys or `.env` files, by tool
or by shell, and search results naming them are hidden. "Allow for this session" covers the same command prefix until
Pi exits. The prompts also appear in T3, so the phone can approve; headless runs (subagents, the advisor, `pi -p`)
cannot ask and are refused instead. A policy file that does not parse turns Personal tools off, like Work.

## Web access (Personal)

`pi-web-access` (pinned) adds `web_search`, `fetch_content` (pages, PDFs, GitHub repos and PRs) and
`get_search_content`. No keys: Exa, or OpenAI search through the ChatGPT login. Work does not have it.

## Sessions: one Pi per session, and runs that survive a dropped connection

T3 runs `pi --mode rpc` on the same session files as terminal Pi. Pi has no lock of its own, so the profile extension
takes one per session file (`<session>.jsonl.lock/`, owner by pid, boot and process start). A second Pi opening a
session that is already open stops and says where it is open: in T3, in a detached terminal (`pi-attach <id>`), or in a
`pi -p` run. `/resume` into a session open elsewhere is refused. The lock survives `/reload` and moves with `/new`,
`/resume` and forks; a crashed owner's lock is taken over. It is a guard, not a hard lock: Pi writes a few things
before extensions start (`--name`, migrating an old session file), and `--no-extensions` skips it. One edge: Pi may not
have written a brand-new session to disk during its first turn, so a `pi -c` then starts another session instead.

On aether (Linux with `dtach`), the launcher runs an interactive Pi under dtach. An SSH drop, a closed laptop or a
closed terminal only ends the dtach client: the run carries on, and `pi-attach` brings it back (with one session it
attaches directly; `pi-attach --list` shows them). The login shell says when sessions are still running. On attach
Pi replays its terminal setup (alternate screen, mouse, paste mode, keyboard protocol) and repaints the whole screen,
since a plain reattach shows a blank or partial screen. dtach has no detach key and no status line; every key goes to
Pi. Print and RPC modes, subcommands and non-terminals are never wrapped; `PI_DETACH=off` opts out. A Pi run under
dtach no longer passes its exit status to the shell.

## Skills (Personal)

`~/.pi/shared/skills/<name>/SKILL.md`, loaded by the Personal profile only. Pi sees each skill's name and description
and reads the rest when a task matches (or on `/skill:<name>`):

| Skill | For |
|---|---|
| `chezmoi-change` | editing these dotfiles safely on both machines (render checks, tests, approval before apply) |
| `home-ops-verify` | rendering and verifying home-ops changes: rendered, merged, reconciled, working; no mutations, no secrets printed |
| `memini-scope-maintenance` | namespace resolution, pins, moving and splitting memories |
| `llm-route-diagnostics` | Pi routing and the LiteLLM gateway: real model IDs, the right wire, multi-turn tool tests |
| `homelab-dns-diagnostics` | internal names across UniFi, Tailscale and aether's `/etc/hosts` sync |

The repo is public: skills hold procedures, never secrets, addresses or Work details.

## Notifications

A run that took 30 seconds or more ends with a terminal notification ("Pi · <dir>: done in 2m 14s"), and so does a
policy prompt waiting for an answer: OSC 777 (Ghostty, iTerm2, WezTerm; it passes through SSH, so aether sessions
notify the laptop) or OSC 99 (Kitty). Only on a terminal; T3 notifies on its own. `PI_NOTIFY_AFTER=<seconds>` changes
the threshold, `PI_NOTIFY=off` turns them off.

## Commit attribution

Commits never credit an AI model, whichever one answered. `~/.pi/shared/context/AGENTS.md` (linked into both agent
dirs) tells every model so, and the profile extension (`commit-trailers.ts`) strips `Co-authored-by:` lines naming a
model and "Generated with …" footers from `git commit` commands before they run. A trailer it cannot remove cleanly
(inside a one-line `$'…'` message) blocks the command with the reason, so the model commits again without it. People's
co-author lines are kept. Native Claude Code has the same off via `attribution` in `~/.claude/settings.json`. Commits
made outside Pi and Claude Code (other agents, other machines) are not covered.

## Isolation (what is and isn't enforced)

- Separate agent dirs, `auth.json`, sessions, npm packages and Claude config/Keychain item per profile. Sessions are
  stamped with their profile; opening one under the other profile is refused.
- Work: only `claude-bridge` (+ `work/*` virtual models). Enforced on model selection, input, and every request
  (main turns, retries, compaction, summaries, extension calls) at `ModelRuntime.prepareRequest`. The launcher strips
  personal provider keys (LiteLLM, OpenAI, Anthropic, OpenRouter, …) from Work and its children. Child fish shells
  don't restore them (`AI_PROFILE=work`), keep `OMP_PROFILE=work`, and nested `codex` gets an empty `CODEX_HOME`.
  Ambient AWS credentials stay for work tooling, but Bedrock is blocked.
- Work tools follow your organisation's Claude Code policy, mirrored by Pi. Your org disables bypass mode, and with
  the bridge Pi, not Claude Code, runs the tools. So Pi reads the managed rules Claude Code caches in
  `~/.pi/profiles/work/agent/claude/remote-settings.json` and applies them. Deny rules block, including inside compound
  commands, substitutions and grep/find/ls results. Allow rules run. Read-only tools run unless a Read rule denies the
  path. Other bash commands and file edits ask in the TUI, with "allow once / for this session / deny". Headless runs
  refuse instead; session approvals carry into subagents and the advisor. Without a readable policy, Work tools are
  off. The Work Claude settings therefore allow `mcp__custom-tools`, so Claude Code relays Pi's tools. Memory tools
  aren't gated: automatic recall and capture send Work turns to memini.janpuc.com regardless, as your omp Work
  profile already does. Your org's Claude policy only allows managed MCP servers; pi-memini isn't MCP, so it isn't
  covered, but it's worth knowing.
- Claude bridge: strict MCP config (no `~/.claude.json`, `.mcp.json` or plugin servers), claude.ai connectors off, no
  Claude subagents/AskClaude, hooks disabled in its own settings. A project `.pi/claude-bridge.json` that loosens this is refused in Work. A project
  `.claude/settings*.json` with `apiKeyHelper`/`ANTHROPIC_*` is refused in both profiles, because it would bill the API.
- Work does not trust project `.pi` config that adds code, packages, MCP servers or model defaults; Pi's built-in MCP is off in Work.
- **Not a sandbox.** Tools run as your user and can read any file, including other tools' credential stores
  (`~/.codex`, `~/.claude`, omp's vault). `--no-extensions` or editing the config bypasses the guard. A project
  `.claude/settings.json` can still set other `env` keys, or re-enable hooks with `disableAllHooks: false`, inside the bridge's Claude Code. Under the
  override, Pi's own children inherit `LITELLM_API_KEY` (fish child shells still drop it).

## Memory (memini)

Native `@eleboucher/pi-memini` in both profiles (no MCP duplicate). Namespaces follow `__memini_namespace_prefix.fish`,
keyed on the launch's profile: Work repos → `work/<repo>`, Work non-repo → `work/scratch` (or `work/<dir>` inside the
tree); Development repos → `homelab/<repo>`; other repos → unprefixed; elsewhere → `homelab/scratch`. Server pins win.
`personal/jan` stays a read-only home overlay in both profiles. In Work, pi-memini tools may not write to it or read
other non-work namespaces. `/memini:namespace` changes the server pin immediately (Pi runs extension commands before
any guard can see them); a pin that crosses profiles is caught by the launch gate below on the next start.

Before Pi starts, the launcher runs the memini handshake with pi-memini's own facts. A Work namespace outside `work/*`, a Work
read set reaching non-work namespaces (other than the home overlay), or a Personal one reaching `work/*` stops the
launch and names the pin. Pins are never rewritten. `PI_MEMINI=off pi …` starts without memory. If memini is down, Pi
starts with a "memini degraded" warning and nothing is saved.

Diagnostics: `pi-profile` (handshake result), `/profile` (profile, scope, chains, selection), `/memini:status`.
The footer status shows `work · mem work/<repo>` (or `… on PERSONAL models`).

## Maintenance

- **Secrets rotated:** `ai-sync`, then restart `pi`.
- **Update:** `brew upgrade pi-coding-agent`. For the packages, bump the pins in
  `home/dot_pi/**/modify_settings.json.tmpl` after reading their changelogs (pi-claude-bridge issue #153: an MCP
  server with codemode exposure breaks prompt capture in 0.9.1, so keep Pi's `mcp.json` empty until a fixed release).
  Then `chezmoi apply` (reinstalls per profile) and `tests/pi/run.sh --typecheck`. After logins: `tests/pi/smoke.zsh --claude`.
  After a Pi upgrade, resync `extensions/subagent` from Pi's `examples/extensions/subagent` and keep the marked
  `pi-profile` env line.
- **Smoke-test residue:** the smoke test writes only to throwaway `pi-smoke-<id>` / `work/pi-smoke-<id>` namespaces and
  deletes them. Memini's promote tick re-upserts rows it listed before a delete, and distils new fact rows from them.
  So a few rows can reappear minutes later in those namespaces, which nothing reads; `tests/pi/smoke.zsh --sweep` removes
  them. The same race can undo a `memory_forget` anywhere, which looks like a memini bug worth reporting upstream.
- **Rollback:** revert the Pi commit and `chezmoi apply`, then remove what chezmoi leaves behind:
  `rm ~/.local/bin/{pi,piw,pi-profile} ~/.config/fish/functions/pi.fish; rm -rf ~/.pi/shared ~/.pi/profiles`, and the two
  Keychain items: `for d in ~/.pi/agent/claude ~/.pi/profiles/work/agent/claude; do security delete-generic-password -s "Claude Code-credentials-$(printf %s $d | shasum -a 256 | cut -c1-8)"; done`.
  `~/.pi/agent` (Personal sessions/auth) can stay; Pi falls back to its stock behaviour. Drop `pi-coding-agent` from
  `packages.yaml` to uninstall.
