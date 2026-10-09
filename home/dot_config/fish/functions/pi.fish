function pi --wraps pi --description "Pi, with pi-claude-bridge on its own Claude Code config"
    # The bridge's Claude Code (and pi-usage's Claude probe) read CLAUDE_CONFIG_DIR, so Pi's
    # Claude sessions get their own login and settings, not ~/.claude's plugins and hooks.
    # ai-sync caches the OpenCode Go and MiniMax keys under PI_ names; Pi's providers read the
    # plain names. Subagents started in the background inherit them from this process.
    # git diff inside Pi prints a plain unified diff instead of the global difftastic one.
    CLAUDE_CONFIG_DIR=$HOME/.pi/agent/claude \
        OPENCODE_API_KEY=$PI_OPENCODE_API_KEY \
        MINIMAX_API_KEY=$PI_MINIMAX_API_KEY \
        GIT_EXTERNAL_DIFF=$HOME/.pi/agent/local/git-plain-diff \
        command pi $argv
end
