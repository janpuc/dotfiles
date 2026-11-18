# Recovery

Backup is a later implementation. Do not claim a successful backup or automatic
restore today. Missing previously initialized workspaces and local-only members
require restoration, not empty replacements. Preserve the external initialization
and lifecycle records under ~/.local/state/agents with platform state.

The approved future backup is encrypted restic over restricted SFTP to BigMouth,
with pinned NAS host key and independent credentials in 1Password. Only hourly
online backups are planned. They are not atomic snapshots and can contain mutually
inconsistent files from active writers. No nightly checkpoint, quiescence or barrier
is part of this platform. Validate a restored copy before using it.

Scope must include full workspaces with .git, submodule stores, dirty and untracked
files, local-only repositories, linked worktrees, .agent recovery state, Pi sessions,
raw agent history, platform state, effective registry and standards, and the chezmoi
source checkout. Exclude runtime locks, sockets, transfer files, narrowly reviewed
caches and external credential caches. Never blanket-exclude dependency lockfiles
or .env filenames. Sessions and untracked files may contain secrets.

Archive in place with agent archive <project>. Archived projects remain in backup
scope. Removing a registry entry does not delete a directory. Before any destructive
action, verify an actual recovery copy and obtain Jan's separate approval for deletion
and retention. An unbuilt backup service cannot satisfy this check.

Future restore verification must check Git object integrity, refs, gitlinks, local-only
commits, dirty and untracked content, linked worktrees, session JSONL and generation
relationships. Restore original absolute paths where possible. Do not restore runtime
locks or generated credential caches. Recover credentials through Jan's independent
1Password access and intentionally regenerate external env files.

Keep the live home workspace and its GitHub safety copy until approved migration and
an isolated restore drill succeed. Home migration and the operator restore runbook
are deferred. Do not reset or reclone the current home-assistant checkout to migrate it.
