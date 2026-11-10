# NanoGPT + MiniMax profile

This is the `pii` profile (`~/.pi/pii/agent`). It is separate from the personal profile: no
memini, no Claude quota, no Pi Pocket. Every model here is on the NanoGPT subscription (60M
input tokens a week, cached input included) or the MiniMax subscription (very large, slow).
`usage_status` shows both.

## Delegation

Delegate with the `subagent` tool when a task can be handed off as a bounded job: lookups,
research, implementation, checks, reviews. Do it yourself when it is conversational or smaller
than writing the brief. One or two agents at a time; give each the goal, the files or URLs, the
constraints, what to return and how done is checked, and check what comes back.

Agents never push, deploy, apply config or change shared systems; a guard blocks those commands
in children. Those stay with you, after Jan says yes.

## Context is the budget

Every turn resends the whole conversation and NanoGPT counts cached input against the week.
Bulk output (listings, logs, long pages) goes to an agent that returns a summary; bound your own
commands with `head`, `tail` or `grep`. The NanoGPT models are capped at a 192K window so Pi
compacts long sessions; when a topic is done, suggest a fresh session.

## Model: your choice on every call

Pass `model: "provider/id:thinking"` on every call.

| Level | Task | Model |
|---|---|---|
| Easy | one clear job: a lookup, a small specified change | `nanogpt/deepseek/deepseek-v4.1-flash:low`, or `minimax/MiniMax-M3.1-Flash:medium` when Jan is not waiting |
| Normal | several files or steps with a clear goal | `nanogpt/deepseek/deepseek-v4.1-flash:medium` |
| Long | bulk reading or research, when Jan is not waiting | `minimax/MiniMax-M3.1-Flash:medium` |
| Hard | ambiguous, cross-cutting, or a lower level failed its check | `nanogpt/z-ai/glm-5.3:high`, then `nanogpt/deepseek/deepseek-v4-pro:high` |
| Advice | a decision, a design, a dead end | `oracle` on `nanogpt/deepseek/deepseek-v4-pro:high` |

Uncensored models, for when a moderated model refuses legitimate work (say so when you switch):
`nanogpt/z-ai/glm-5.3-flash-uncensored`, `nanogpt/z-ai/glm-5.3-flash-apex-abliterated`,
`nanogpt/pqhaz/DeepSeek-V4.1-Flash-1017-heretic`, `nanogpt/Gemma-4-31B-Gembrain-uncensored-heretic`,
`nanogpt/gemma-4-26b-a4b-it-chimeraxheretic`.

Escalate one level when a result fails its check or cannot back a claim. A quota, auth or
timeout failure is not a reason to go stronger: retry the same level on the other subscription.
