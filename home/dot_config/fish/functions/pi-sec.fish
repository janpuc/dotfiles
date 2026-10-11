function pi-sec --wraps pi --description "Pi in the security-research profile, from ~/Security"
    # A separate PI_CODING_AGENT_DIR gives this profile its own settings, models, MCP servers,
    # packages and sessions: no memini, no Claude bridge, no Pi Pocket (see
    # ~/.pi/security/agent/AGENTS.md). It is not a sandbox — Pi still runs as this user.
    #
    # ai-sync caches the NanoGPT subscription key under PI_NANOGPT_API_KEY; the provider reads the
    # plain name, so it stays off in every other tool. Subagents inherit it from this process.
    # Pi has no --cwd, so start it from ~/Security: that is where it reads the engagement scope
    # in ~/Security/AGENTS.md and where its project sessions live.
    set -l dir $HOME/Security
    if not test -d $dir
        echo "pi-sec: $dir does not exist" >&2
        return 1
    end
    if not set -q PI_NANOGPT_API_KEY
        echo "pi-sec: PI_NANOGPT_API_KEY is not set — run ai-sync" >&2
        return 1
    end
    pushd $dir
    PI_CODING_AGENT_DIR=$HOME/.pi/security/agent \
        NANOGPT_API_KEY=$PI_NANOGPT_API_KEY \
        GIT_EXTERNAL_DIFF=$HOME/.pi/agent/local/git-plain-diff \
        command pi $argv
    set -l status_code $status
    popd
    return $status_code
end
