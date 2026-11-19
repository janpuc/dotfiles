# Tasks

A task's immutable id matches ^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$ for tickets or
^[a-z0-9][a-z0-9-]{1,39}$ for slugs. Ids are unique per project and never reused.
Attaching a ticket changes metadata, not paths, branches or sessions. Default maxOpen
is four, including closing tasks.

agent task new [project] <TICKET-ID|--slug slug> "<brief>" creates tasks/<id>/:

- BRIEF.md: front matter id, ticket (none if absent), opened (UTC), status
- STATE.md: knowledge.md's State headings
- RESULT.md at close: Outcome, Changes, Verification, Learned, Open headings

Cwd is tasks/<id>, Rex tab task:<id>, Pi session <project>-task-<id>. PI_PROJECT_DIR
stays the workspace. Context includes standards, project PROJECT.md, task BRIEF.md
and STATE.md within 48 KiB. Tasks restart on the same session and never rotate.
Runtime state is .agent/tasks/<id>/, outside Git.

Write only your task folder, new notes/knowledge/ evidence pages and your worktrees.
Never edit project PROJECT.md or STATE.md, other tasks or other projects. Create
needed code worktrees at .worktrees/<repo>/<id>/ on branch task/<id>. Prefix commits
[TICKET] when attached, otherwise [task:<id>]. Include the ticket in RESULT's title.
Use the project's memini namespace with ticket:<ID> or task:<slug> tags and project,
immutable task id and ticket metadata, never a child namespace.

Close queues an idle-boundary message asking you to write RESULT.md. Emit
TASK_CLOSE_READY only on success. The platform validates headings, sends a fold to
the project inbox, marks closed and stops Pi. Jan accepts the fold before the owner
reconciles project notes. Failed closes stay closing. Resolve the blocker and repeat
close. Folders, branches, worktrees, sessions and drafts are never deleted.
