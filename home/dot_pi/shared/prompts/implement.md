---
description: Implement with Opus; delegate only bounded separable work and review substantive changes
---
Implement: $@

Keep ownership of the design and closely coupled implementation in this main Opus session.
Use a scout/planner worker only if a specific read-only investigation is useful. Supply the
assignment, relevant constraints, exact tools and acceptance criteria; do not delegate by default.

If a bounded editing worker is useful, first identify the exact files it owns and explicitly grant
its necessary read/edit/write/bash tools. One writer at a time; wait for completion or cancellation
before touching the checkout yourself. Cancel and rebrief if requirements change.

Edit and test are authorized; publishing, deploying and chezmoi apply/update need a separate decision.
Workers must not commit. Validate the actual diff and tests, then automatically obtain independent
read-only review for substantive changes. Give the reviewer the diff, relevant file paths and test
results; it has no bash tool. Use GPT/Sol for the reviewer. Address demonstrated findings and report
changes, validation and remaining limitations.
