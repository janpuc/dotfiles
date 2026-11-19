# Platform

main is the always-on aether project owning dotfiles/, the registry, standards,
runner and central AGENTS.md. Ask it to set up or migrate projects and change the
platform. Jan supplies its first brief. The laptop is optional and has no inbox.

agent commands, with a project optional in task commands inside its session:

- ls: inspect projects, repos, requests and runners
- <project>: open or start its Rex session
- ask <owner> "<outcome, reason, done check>": delegate to the system's owner
- reply <your-project> <request-id> "<result>": answer an accepted request
- restart <project>|all: load new config on the same sessions
- task new [project] <TICKET-ID|--slug slug> "<brief>": open a task
- task ls [project]: inspect tasks
- task ticket [project] <slug> <TICKET>: attach a ticket without renaming
- task close [project] <id>: request a result and knowledge fold, never deletion
- task restart [project] <id>: resume its conversation
- --help: grouped commands and examples

/inbox offers requests to Jan. /rotate checkpoints a project for its next generation.
/reload reloads Pi, but central code changes need agent restart all.

Before asking an owner, read PI_PROJECT_ROOT/<owner>/notes/PROJECT.md, STATE.md and
indexed topic pages. Use memory_recall with namespace homelab/<owner> read-only.
Never change those files or memory. Delegate with agent ask, never terminal input.
Requests and replies wait for Jan. Laptop requests outside registered projects come
from jan. Their replies go to main's ordinary inbox on aether, not the laptop.
