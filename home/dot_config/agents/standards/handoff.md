# Handoff

Before a generation change, checkpoint notes/STATE.md and durable facts in
notes/PROJECT.md and indexed notes/knowledge/ pages. Preserve uncertainty, pending
approvals, files touched and next actions. Supplement with memini, not instead of
workspace knowledge. Commit intentional workspace changes with explicit paths and
git -C. Stage updated gitlinks deliberately. Never automatically push.

The existing rotation extension still asks for project AGENTS.md updates. That is
legacy behavior awaiting replacement. Do not create one. Use the knowledge files
instead and explicitly note this discrepancy when preparing a handoff.

Runtime protocol remains generation based. The extension writes
.agent/handoff-<N+1>.md, then atomically writes N+1 to .agent/rotate-requested and
requests graceful shutdown. The runner alone advances .agent/generation after Pi
exits. It validates the next handoff and recovers an interrupted generation advance.
An ordinary restart resumes the existing Pi session without replaying the handoff.

A failed knowledge checkpoint or handoff must keep the old session alive. Invalid
rotation requests are reported and retained, not silently discarded. Retain old Pi
sessions and raw history. .agent runtime files must not be committed to workspace
Git. Existing tracked runtime state requires an explicit migration, not deletion.

The later rotation update must remove project AGENTS references, use the context
loader's mandatory standards and knowledge contract, and preserve current crash
recovery behavior. There is no backup barrier or nightly pause to coordinate with.
