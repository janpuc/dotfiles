# Platform

dotfiles is the aether project owning janpuc/dotfiles: machine config, the registry,
standards, runner and central AGENTS.md. It takes platform requests like any owner.
Ask it to set up or migrate projects and change the platform. Jan supplies its first brief. The laptop is optional and has no inbox.
work is the single coordinator on sisyphus at ~/Work/work. dotfiles may SSH to sisyphus
only for agent ls, agent restart all and chezmoi update, never read ~/Work.
Work platform requests use agent ask dotfiles. A restricted work-only key delivers them
to aether and pulls replies. dotfiles never connects to sisyphus to deliver a reply.

agent commands, with a project optional in task commands inside its session:

- ls: inspect projects, repos, requests and runners
- <project>: open or start its Rex session
- ask <owner> "<outcome, reason, done check>": delegate to the system's owner
- reply <your-project> <request-id> "<result>": answer an accepted request
- restart <project>|all: load new config on the same sessions
- task new [project] <TICKET-ID|--slug slug> "<brief>": open a task
- task ls [project]: inspect tasks
- task send [project] <id> "<text>": message a task session at its next idle point
- task ticket [project] <slug> <TICKET>: attach a ticket without renaming
- task close [project] <id>: request a result and knowledge fold, never deletion
- task restart [project] <id>: resume its conversation
- scratch ["<brief>"|ls|fold <id> <project>|promote <id> <name>]: free-standing work
- --help: grouped commands and examples

/inbox offers requests to Jan. /rotate checkpoints a project for its next generation.
/reload reloads Pi, but central code changes need agent restart all.

On aether, before asking another aether owner, read its PROJECT.md, STATE.md and
indexed topic pages under PI_PROJECT_ROOT and recall homelab/<owner> read-only.
This does not permit reading Work. Work agents never read personal files or memory.
Ask dotfiles for platform help without reading its workspace first. Never change another
owner's files or memory. Delegate with agent ask or agent task send, never terminal input.
Requests, replies and folds reach the agent by themselves. Laptop requests outside registered projects come
from jan. Their replies go to the dotfiles project's ordinary inbox on aether, not the laptop.
