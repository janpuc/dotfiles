# Session

Validate PI_PROJECT, PI_PROJECT_ROOT and PI_PROJECT_DIR against the host registry.
Aether's root is ~/Development and sisyphus's is ~/Work. Children retain identity,
namespace and context. Namespaces are platform-owned: personal/jan for personal
facts, homelab for small shared infra facts, homelab/<project> for registered aether
projects and work for Work sessions. Sisyphus uses its own memini key with MEMINI_HOME
unset, never personal inheritance. Tasks never get child namespaces. They tag the
project namespace with ticket:<ID> or task:<slug>. Other unregistered sessions on
aether and the laptop share homelab/scratch. Work intake uses the fixed work namespace.

Before work load all ordered standards/manifest.json files and verify every SHA-256.
Then load notes/PROJECT.md and notes/STATE.md, or for tasks project PROJECT.md plus
task BRIEF.md and STATE.md. The UTF-8 budget is 48 KiB. Missing, invalid or oversized
context is an actionable error, never silently truncated. Move history to indexed
knowledge pages, which are read as needed.

project-context injects before the first run, after compaction or session switching,
and on content hash changes. Its revision supersedes earlier context. After mid-run
compaction re-read your STATE.md. Derived .agent/context.json is not an authority.
Central AGENTS.md, extension and settings changes need a runner restart or project
rotation, not merely /reload. Content-only standards changes inject on the next run.

Inspect workspace and members before editing. Preserve dirty and detached trees.
Missing local-only members require restore. Keep unrelated Rex tabs. Finish current
work before offering /rotate when due. There is no backup pause or barrier protocol.
