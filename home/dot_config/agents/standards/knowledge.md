# Knowledge

The agent owns project knowledge and keeps it current without asking Jan to maintain
routine documentation. Preserve Jan's edits. Knowledge describes evidence and does
not authorize publishing, deployment or other shared changes.

notes/PROJECT.md has one project title and exactly these level-two headings in order:

- Facts
- Operating constraints
- Systems
- Knowledge index

Keep it concise. The index links topic files under notes/knowledge/ with a one-line
summary. Record durable operating constraints here without duplicating central policy.

notes/STATE.md has the title State and exactly these level-two headings in order:

- Current work
- Verified state
- Open threads
- Pending approvals
- Next actions

Record verification dates, concrete observations and remaining uncertainty. Pending
approvals holds only open questions for Jan, one line each with your recommendation,
and agent todo lists them. Remove an entry once answered. Keep old work out of the
current-state section. Reconcile conflicting observations by evidence and date.

Each notes/knowledge/<topic>.md has a topic title and these level-two headings in order:

- Summary
- Evidence
- Verification
- History

Evidence identifies source paths, commands or URLs and observation dates. Verification
records the last check date and confidence as verified, tentative or historical.
History dates superseded facts and explains what replaced them. Do not present stale
facts as current or silently discard a contradiction. Avoid credentials and raw tokens.

Mandatory standards plus PROJECT and STATE have a combined 48 KiB UTF-8 budget.
Move history and details to indexed topic pages rather than silently truncating.
Detailed pages are loaded as needed, not all injected at startup.

memini is supplementary searchable recall. Duplicate recovery-critical facts in
workspace knowledge. Namespaces are platform-owned, never derived from paths or
task ids. Task entries stay in homelab/<project>, tagged ticket:<ID> or task:<slug>,
with project, task id and ticket metadata. Shared infra belongs in homelab and
personal facts in personal/jan. Unregistered sessions use homelab/scratch.
Memory entries and old handoffs never lift the hard-deny list. Write
prose with minimal punctuation, no em or en dashes, no semicolons and no ellipses.
