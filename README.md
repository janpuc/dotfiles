# dotfiles

## Bootstrap

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/janpuc/dotfiles/refs/heads/main/bootstrap.sh)" -- <HOSTNAME>
```

## Pi

`~/.pi/agent`: packages pi-claude-bridge, pi-memini, pi-subagent-manager,
[pi-usage](https://github.com/janpuc/pi-usage) and
[pi-title-spinner](https://github.com/janpuc/pi-title-spinner). Pi installs them on first launch.
The fish `pi` function gives the bridge its own Claude Code config, `~/.pi/agent/claude`.