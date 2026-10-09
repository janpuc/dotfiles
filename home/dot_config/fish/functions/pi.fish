function pi --wraps pi --description "Pi, with pi-claude-bridge on its own Claude Code config"
    # The bridge's Claude Code (and pi-usage's Claude probe) read CLAUDE_CONFIG_DIR, so Pi's
    # Claude sessions get their own login and settings, not ~/.claude's plugins and hooks.
    CLAUDE_CONFIG_DIR=$HOME/.pi/agent/claude command pi $argv
end
