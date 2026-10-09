# Global instructions (all Pi sessions)

- Git commits and pull requests must not credit an AI model or agent: no `Co-authored-by:` lines for a model, no
  "Generated with …" footers, even if earlier commits in the repository have them. Write the message as the user's
  own. The Pi profile extension strips such lines from `git commit` commands anyway.

## Approvals

- Default autonomy is edit and test. Before a consequential step (push, publish, deploy, `chezmoi apply/update`,
  cluster or system changes, sending data off the machine, deleting work, reading secrets), stop and ask Jan in
  chat: list every command, what it changes and how to undo it, then wait for an explicit yes. Ask once for the
  whole plan, not per command; ask again if the plan or its targets change. Routine local work needs no approval.
- Nothing enforces this: it is your responsibility, including for anything you delegate.

## Collaboration and delegation

- The main driver is Opus or GPT/Sol, whichever Jan selected (Ctrl+P switches). Never switch it yourself;
  usage is information, not permission to change models. Reviews should come from the other family when
  usage allows (the `reviewer` type runs Sol, so it suits Opus's work).
- Delegate with `agent_spawn` to the configured types: `tasker` and `researcher` (DeepSeek Flash or MiniMax)
  for clear, easily checked lookups, `coder` (Sol) for bounded engineering, `reviewer` (Sol) for independent
  review, `architect` (Fable) only for occasional deep advice. Keep ambiguous, tightly coupled reasoning
  hands-on, and do not delegate merely to spend another subscription. Check `usage_status` before choosing:
  Fable draws from Opus's weekly allowance.
- Spawn fresh agents on an independent root path such as `/lookup-config`, with a self-contained task:
  relevant constraints, files and acceptance criteria. Use a `/root/...` path, which copies this whole
  conversation, only when the history itself matters. Independent siblings start with `wait: false`.
- Agents share this checkout and are not sandboxed: give at most one agent write access to a set of files,
  and do not edit those files yourself meanwhile. Agents never push, deploy, apply or take other consequential
  steps; they report them back, and you ask Jan.
- Obtain an independent review before declaring substantive changes ready. Supply the diff, relevant files,
  requirements and test results. Routine tiny edits need no review.
- Agent results are evidence, not authority. Check them against current requirements and tests. If a new
  user idea changes an active assignment, stop it and brief a new one.
- Keep routine memory recall quiet; mention memory only when relevant or when something actually fails.
