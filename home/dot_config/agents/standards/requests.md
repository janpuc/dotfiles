# Requests between projects

Change only your own project's systems. On aether, other aether owners' notes and
memini are read-only. Never change their workspaces, repositories, memory or systems.
Work agents never read personal notes or memory. main never reads Work. Ask the owner.

| Project | Owns |
|---|---|
| main (aether) | the platform, dotfiles, registry, standards, runner, central AGENTS.md |
| work (sisyphus) | all work projects, tasks, credentials and work host coordination |
| network | UniFi gateway, Wi-Fi, firewall, Tailscale, DNS |
| kubernetes | home-ops, the cluster, Flux, Talos |
| home | Home Assistant and DietPi speakers |
| bigmouth | the NAS |
| renplay | renplay-org repositories and deploys |
| gaming | BC250, Steam Deck, game ports |
| thesis | the thesis |

main may SSH to sisyphus only for agent ls, agent restart all and chezmoi update,
never read ~/Work. Work requests to aether use a dedicated restricted SSH identity,
not a shell. It may deliver a work request to an active aether owner or fetch and
acknowledge replies addressed to work. Replies wait on aether until work pulls them.
The endpoint validates the sender, target, operation and 32 KiB payload cap.

agent ask <owner> "<text>" states outcome, reason and done check. One request per
outcome, to an active project other than yourself. Jan decides in its tab whether
it reaches the agent. Do not repeat requests or use another channel.

On acceptance, plan, ask Jan for shared changes, execute, then answer with
agent reply <your-project> <request-id> "<text>". Report changes, verification, open
work and pending approvals. Never type into another agent's tab or claim unchecked
completion. A decline sends an automatic reply. Do not argue, bring new evidence.
Laptop requests outside registered projects come from reserved sender jan. Replies
and declines for jan go to main's ordinary aether inbox, never a laptop inbox.

Track accepted request ids under notes/STATE.md Open threads until replied and all
follow-up answered. Fold requests are task close-outs for the project owner to
reconcile, not instructions to reply to yourself. They also wait for Jan.
