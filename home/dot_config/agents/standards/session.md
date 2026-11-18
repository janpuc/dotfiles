# Session

Validate PI_PROJECT and PI_PROJECT_DIR against the registry and expected workspace.
Use the inherited MEMINI_NAMESPACE, normally homelab/<project>. Children must retain
validated project identity and the same mandatory context as their parent.

Before work, load all ordered files in standards/manifest.json, notes/PROJECT.md
and notes/STATE.md. Check the manifest version and each SHA-256 digest. Missing,
invalid or oversized mandatory context is an actionable error, not an invitation to
proceed with partial instructions. Do not silently truncate safety information.

The future context loader must inject a persistent context message before the first
model turn, after compaction, session switching and rotation. It must detect content
hash changes before the next turn, inject the new revision and explicitly supersede
prior standards. Include the knowledge index, not all detailed pages. The initial
UTF-8 budget is 24 KiB for standards plus PROJECT and STATE. Move history to dated
knowledge pages when this limit is reached.

Until that loader is installed, explicitly read these files before work and after
compaction. Manual reads are an interim measure, not proof of automatic loading.
Derived .agent/context.json may record hashes and the loaded revision. It is not
an authority and must be regenerable.

Central AGENTS.md, extension code and settings updates require a clean runner
restart or generation rotation. /reload alone does not reliably refresh bridge
context. Content-only standards changes use next-turn injection once implemented.

Inspect workspace and member status before editing. Never repair dirty or detached
repositories by resetting them. Report missing local-only members as restore needed.
Keep the existing Rex session and unrelated tabs. When rotation is due, finish or
checkpoint the task and offer /rotate. There is no backup pause or barrier protocol.
