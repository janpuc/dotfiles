# Workspace

The workspace is a local Git repository at ~/Development/<project>. Aether is the
writer unless Jan explicitly transfers ownership. Every agent runs as ubuntu. This
is not an isolation boundary. Work repositories stay off aether.

The registry owns identity, lifecycle, defaults, secret references and optional seed
repositories. Seeds are used only at first initialization. After that .gitmodules
and committed gitlinks own membership, URLs and selected committed revisions.
Removing a seed or registry entry never removes files.

Standard layout:

- notes/PROJECT.md holds facts, constraints, systems and the knowledge index
- notes/STATE.md holds current work and pending approvals
- notes/knowledge/*.md holds detailed evidence-backed knowledge
- plans/ and scripts/ hold ordinary workspace content
- mise.toml holds project tools, tasks and non-secret environment
- Direct child code repositories are submodules
- Non-Git folders such as ha-inventory/ are ordinary tracked content
- .worktrees/<repo>/<task>/ holds linked task worktrees
- .agent/ holds runtime generation, handoff, rotation, context and lock files

Ignore .agent/ and .worktrees/ in workspace Git, not code members. Runtime state
must not be rewound by Git checkout. Backup must include runtime recovery state
and worktrees but exclude locks. Backup is not implemented yet.

Do not create a workspace AGENTS.md or another project instruction file. Central
standards are mandatory. Knowledge files are evidence, not platform policy.

Use agent-run --register <project> <member> [url] to register a repository and stage
its gitlink and .gitmodules. Without a URL it creates or registers a local-only
repository. Review and commit explicit workspace paths afterward. Member names and
paths must be unique single directory components, contained without symlink escapes.
Never repurpose notes, plans or scripts as member paths.

An external initialization record prevents recreating a lost workspace. Existing
workspaces require explicit inspection with agent adopt <project>. Adoption does
not migrate legacy members or consume seeds. Archiving stops the managed Pi runner
and records local lifecycle state. It never moves or deletes the workspace. Archived
projects are excluded from agent up and remain in future backup scope.
