# Recovery

The hourly encrypted restic backup to BigMouth is the platform's only backup. It runs as
ubuntu, is triggered by a system timer and alerts on failure and on two hours without a
success. It is online: there is no nightly checkpoint, quiescence or barrier, so it can
capture mutually inconsistent files from active writers. No isolated restore drill has
succeeded yet. Do not claim the data is protected, and do not claim a successful backup or
automatic restore without checking `aether-backup status` on aether.

Missing previously initialized workspaces and local-only members require restoration, not
empty replacements. The external initialization and lifecycle records under
~/.local/state/agents are in backup scope. Restore them together with the workspace they
describe, and preserve them with platform state.

Scope is encrypted restic over restricted SFTP to BigMouth with the pinned NAS host key and
a password from 1Password, and it includes full workspaces with .git, submodule stores,
dirty and untracked files, local-only repositories, linked worktrees, .agent recovery state,
Pi sessions, raw agent history, platform state, effective registry and standards, and the
chezmoi source checkout. It excludes runtime locks, narrowly reviewed caches and external
credential caches, which sit outside the included paths. There is no blanket exclusion of
dependency lockfiles or .env filenames, because a lockfile or env sample can be the only
copy of a decision. Sessions and untracked files may contain secrets.

Archive in place with agent archive <project>. Archived projects remain in backup scope.
Removing a registry entry does not delete a directory. Before any destructive action, verify
an actual recovery copy and obtain Jan's separate approval for deletion and retention. A
backup that has never been restored cannot satisfy this check.

Restore verification must check Git object integrity, refs, gitlinks, local-only commits,
dirty and untracked content, linked worktrees, session JSONL and generation relationships.
Restore original absolute paths where possible. Do not restore runtime locks or generated
credential caches. Recover credentials through Jan's independent 1Password access and
intentionally regenerate external env files.

Keep the live home workspace and its GitHub safety copy until approved migration and an
isolated restore drill succeed. Home migration is deferred. Do not reset or reclone the
current home-assistant checkout to migrate it. The operator restore runbook is the Restore
section of docs/aether.md in the dotfiles repository.