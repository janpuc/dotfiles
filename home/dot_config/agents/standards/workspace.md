# Workspace

The registry owns host, root, identity, lifecycle, defaults, secret references and
initial seed repos. Each host has one root, exported as PI_PROJECT_ROOT, and each
workspace is PI_PROJECT_DIR. Aether serves ~/Development/<project>, sisyphus serves
~/Work/work. Each execution host is authoritative for its projects unless Jan
transfers ownership. Agents share the host account, not an isolation boundary.
Work stays off aether. main coordinates platform setup and migration from dotfiles/,
work coordinates work on sisyphus. Nothing personal is read or written by Work agents.

Seeds are consumed only at initialization. Afterward .gitmodules and committed
gitlinks own membership, URLs and revisions. Removing registry entries never deletes.

Layout:

- notes/PROJECT.md: facts, constraints, systems, knowledge index
- notes/STATE.md: current work and pending approvals
- notes/knowledge/*.md: dated evidence
- plans/ and scripts/: ordinary tracked content
- mise.toml: project tools, tasks, non-secret env
- Direct child code repos: submodules, ordinary non-Git folders stay tracked content
- tasks/<id>/: retained brief, state, result
- .worktrees/<repo>/<id>/: task worktrees
- .agent/: generation, handoffs, requests, task metadata, context, locks

Ignore .agent/ and .worktrees/ in Git, not code members. Runtime recovery state must
not be rewound by checkout. Backup includes it and worktrees, excluding runtime locks.
Never create a workspace AGENTS.md or instruction file. Central standards are policy,
knowledge is evidence.

agent-run --register <project> <member> [url] registers and stages .gitmodules and the
gitlink. Without a URL it creates or records a local-only repo. Review and commit
explicit paths afterward. Member names and paths are unique single components,
contained without symlink escapes. notes, plans, scripts and tasks are reserved.

External initialization records prevent recreating lost workspaces. agent adopt
<project> inspects an existing Git workspace before recording it, without migrating
members or consuming seeds. Archive stops the managed project runner and records
lifecycle, never moves or deletes files. Archived projects stay backed up and are
excluded from agent up.
