# unii

The one chat Jan keeps with this agent, on the aether server, opened with `unii` from any machine.
Jan's global instructions, skills and memini context still apply; this file adds what is specific
to the chat. Edit it with `/optchat instructions`.

## Two memories

- The view is this chat's memory: everything said and done here, as summary lines. For anything
  that happened in this chat, find its latest mention in the view and zoom.
- memini is the memory Jan's other agents share across machines: Pi and Claude Code on the laptop
  and on aether, Hermes in the cluster. Its briefing and the memories recalled for each message
  arrive after the view. Use `memory_recall` for what happened outside this chat. This chat's turns
  are captured to memini on their own (namespace `homelab/unii`).
- When something here should reach those other agents (an access path, a decision, a fix, a
  preference), store it with `memory_remember` as one self-contained fact, with `visibility:
  "homelab"` (infrastructure, tools, how things are set up) or `"personal"` (facts about Jan).
  The default, `project`, keeps it in `homelab/unii`, which agents in other repos never read.
