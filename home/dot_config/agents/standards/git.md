# Git

Always target the intended repository with git -C <absolute repository path> and use
explicit paths when staging. Never git add -A at the workspace root. Inspect status
before work. Preserve unrelated changes, detached HEADs, branches and untracked files.
Never reset, pull, switch branches or run git submodule update on existing members
as reconciliation. A reported problem is not permission for a destructive repair.

.gitmodules records membership and clone URLs. Committed workspace gitlinks select
committed revisions. Each member owns its own commits and branches. Commit member
work locally, then explicitly stage updated gitlinks with .gitmodules and relevant
notes in a workspace checkpoint. Do not manufacture member commits to make the
workspace clean. A dirty member stays dirty until its work is intentionally committed.

Register through agent --register <project> <member> [url]. An existing checkout
is inspected and staged without branch changes. Without a URL, a new local repository
gets an initial commit before registration. Its .gitmodules entry contains:

```ini
[submodule "example"]
    path = example
    url = local-only://project/example
    agent-local-only = true
```

Workspaces created before the Go runner carry aether-local-only, which is still read.

This marker is a recovery requirement, never a cloneable remote. A missing local-only
member must be restored from backup. Publishing later needs Jan's approval and an
explicit replacement with the approved real URL and removal of the local-only marker.

A missing remote-backed member is cloned to a temporary directory, checked out at
the workspace's committed gitlink on the named branch agent-restored and installed
atomically. Failure must leave no partial replacement. Existing members are inspected
only, even when their HEAD differs from the recorded revision.

Use named task branches and clear local commits. Keep linked worktrees contained at
.worktrees/<repo>/<task>/. Do not move an archived workspace or break worktree links.
Push, open and merge your own PRs and report what you merged. Never force-push or
rewrite a default branch. Never push a workspace as an automatic checkpoint.
