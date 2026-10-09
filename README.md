# dotfiles

## Bootstrap

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/janpuc/dotfiles/refs/heads/main/bootstrap.sh)" -- <HOSTNAME>
```

## Pi

`~/.pi/agent`: packages pi-claude-bridge, pi-memini, pi-subagents, pi-web-access,
[pi-usage](https://github.com/janpuc/pi-usage) and
[pi-title-spinner](https://github.com/janpuc/pi-title-spinner). Pi installs them on first launch.
The fish `pi` function gives the bridge its own Claude Code config, `~/.pi/agent/claude`, and
hands Pi the OpenCode Go and MiniMax keys.

Opus is the main model; it delegates to pi-subagents agents and picks each one's model by
usage, following `AGENTS.md`. `settings.json` limits subagents to the worker subscriptions,
`extensions/subagent/config.json` trims the tool, and `local/bc250-quiet-hours.ts` keeps the
loud BC250 board (LiteLLM, `models.json`) to 23:00-07:00 unless asked for.