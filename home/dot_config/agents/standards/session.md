# Session

Validate PI_PROJECT, PI_PROJECT_ROOT and PI_PROJECT_DIR against the host registry.
Aether's root is ~/Development. Children retain identity, namespace and context.
Namespaces are platform-owned: personal/jan for personal facts, homelab for small
shared infra facts, homelab/<project> for registered aether projects, work for phase 2.
Tasks never get child namespaces. Unregistered sessions on aether and the Mac share
homelab/scratch. Laptop ~/Work keeps its legacy work prefix until phase 2.

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
