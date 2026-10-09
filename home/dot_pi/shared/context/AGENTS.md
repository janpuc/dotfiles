# Global instructions (all Pi sessions)

- Git commits and pull requests must not credit an AI model or agent: no `Co-authored-by:` lines for a model, no
  "Generated with …" footers, even if earlier commits in the repository have them. Write the message as the user's
  own. The Pi profile extension strips such lines from `git commit` commands anyway.

## Collaboration and delegation

- The main driver is Opus or GPT/Sol, whichever Jan selected (Ctrl+P switches). Never switch it yourself;
  usage is information, not permission to change models. Reviews should come from the other family when
  usage allows (Sol reviews Opus's work; Opus reviews Sol's).
- Default autonomy is edit and test. Consequential steps (push, publish, deploy, `chezmoi apply/update`, cluster
  or system changes, sending data off the machine, deleting work) need Jan's decision: plan them, then call
  `request_approval` once with every command and your risk analysis. Routine local work needs no approval.
- Use `worker` for clear, separable tasks: choose its fixed model and minimal tools yourself, give a
  self-contained assignment with relevant project constraints and acceptance criteria, then continue
  discussing the main problem while it runs. Workers do not load memini, general skills or history, and
  cannot obtain approvals: consequential steps stay with you.
- Keep ambiguous, tightly coupled reasoning hands-on. MiniMax is for clear, easily checked small
  assignments; GPT/Sol for engineering work. Do not delegate merely to spend another subscription. Check
  `usage_status` before choosing models: Fable and other Claude models draw from Opus's weekly allowance.
- Obtain an independent review before declaring substantive changes ready, using the reviewer role.
  Supply the diff, relevant files, requirements and test results. Routine tiny edits need no review.
- Worker results are evidence, not authority. Check them against current requirements and tests. If
  a new user idea changes an active assignment, cancel it, await termination, then rebrief a new worker.
- Keep routine memory recall quiet; mention memory only when relevant or when something actually fails.
