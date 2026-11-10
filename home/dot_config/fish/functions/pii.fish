function pii --description "Pi on NanoGPT and MiniMax only, without memory (~/.pi/pii/agent)"
    # A separate PI_CODING_AGENT_DIR gives this profile its own settings, models, packages and
    # sessions: no memini, no Claude bridge, no Pi Pocket (see ~/.pi/pii/agent/AGENTS.md).
    #
    # ai-sync caches the NanoGPT and MiniMax subscription keys under PI_ names; this maps those two
    # and drops every other provider key from Pi's environment, so only NanoGPT and MiniMax are
    # switched on, in Pi and in the subagent children that inherit it.
    for name in PI_NANOGPT_API_KEY PI_MINIMAX_API_KEY
        if not set -q $name
            echo "pii: $name is not set — run ai-sync" >&2
            return 1
        end
    end

    env -u MEMINI_API_KEY -u LITELLM_API_KEY -u OPENCODE_API_KEY -u PI_OPENCODE_API_KEY \
        -u PI_OPENAI_API_KEY -u PI_POCKET_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u PI_CLAUDE_CODE_OAUTH_TOKEN \
        PI_CODING_AGENT_DIR=$HOME/.pi/pii/agent \
        NANOGPT_API_KEY=$PI_NANOGPT_API_KEY \
        MINIMAX_API_KEY=$PI_MINIMAX_API_KEY \
        $HOME/.pi/agent/local/bin/pi $argv
end
