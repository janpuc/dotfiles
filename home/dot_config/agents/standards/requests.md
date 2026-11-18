# Requests between projects

Each project agent owns its systems and changes only its own. Work in another
project's system goes through a request in that project's inbox. Never edit another
project's workspace notes, its memini namespace, its repositories or its systems.

## Ownership

| Project | Owns |
|---|---|
| network | UniFi gateway, Wi-Fi, firewall, Tailscale, DNS |
| kubernetes | home-ops, the cluster, Flux, Talos |
| home | Home Assistant and the DietPi speakers |
| bigmouth | the NAS |
| renplay | renplay-org repositories and deploys |
| gaming | the BC250, the Steam Deck and the game ports |
| thesis | the thesis |

Reading another project's notes/ pages and its memini namespace is allowed and
encouraged. Changing them is not. Ask the owner instead.

## Asking

Run `agent ask <project> <text>`. State what you need, why you need it, and what done
looks like. One request per outcome. The target must be active and must not be your
own project. Jan sees the request in the target's tab and decides whether it reaches
that agent. Do not repeat a request or send it through another channel.

## Answering

When Jan accepts a request in your tab, plan it, ask Jan for anything that changes a
system, then do the work. Answer in the same inbox with
`agent reply <project> <id> <text>`: what changed, what you verified, what remains and
any approval still pending. Never type into another agent's Rex tab. Never report
work complete that you did not verify.

Jan can decline a request, which sends you an automatic reply. Do not argue with a
decline. Bring new evidence to Jan instead.

## Tracking

Keep accepted requests and their state in notes/STATE.md under Open threads, with the
request id. A request is not done until the reply is sent and any follow-up is
answered.