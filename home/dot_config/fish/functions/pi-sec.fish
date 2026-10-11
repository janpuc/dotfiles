function pi-sec --description "Pi in the security-research profile, in ~/Security/<project>"
    # A separate PI_CODING_AGENT_DIR gives this profile its own settings, models, MCP servers,
    # packages and sessions: no memini, no Claude bridge, no Pi Pocket (see
    # ~/.pi/security/agent/AGENTS.md). It is not a sandbox — Pi still runs as this user.
    #
    # Each project is a directory under ~/Security whose AGENTS.md is its scope; Pi has no --cwd,
    # so it starts from there and reads that file next to the profile's shared rules. A new
    # project gets the scope template and the artefacts/, tools/ and reports/ layout.
    #
    # ai-sync caches the NanoGPT subscription key under PI_NANOGPT_API_KEY; the provider reads the
    # plain name, so it stays off in every other tool. Subagents inherit it from this process.
    set -l root $HOME/Security
    set -l agent_dir $HOME/.pi/security/agent

    if test (count $argv) -eq 0; or contains -- $argv[1] -h --help
        echo "Usage: pi-sec <project> [pi arguments…]"
        echo "Projects in $root:"
        for d in $root/*/
            printf '  %s\n' (basename $d)
        end
        return 0
    end

    set -l project $argv[1]
    if not string match -qr '^[A-Za-z0-9][A-Za-z0-9._-]*$' -- $project
        echo "pi-sec: '$project' is not a project name (letters, digits, . _ -)" >&2
        return 1
    end
    if not set -q PI_NANOGPT_API_KEY
        echo "pi-sec: PI_NANOGPT_API_KEY is not set — run ai-sync" >&2
        return 1
    end

    set -l dir $root/$project
    if not test -d $dir
        mkdir -p $dir/artefacts $dir/tools $dir/reports
        string replace -a PROJECT $project <$agent_dir/templates/project-AGENTS.md >$dir/AGENTS.md
        echo "pi-sec: created $dir — fill in its AGENTS.md before touching a target"
    end

    pushd $dir
    PI_CODING_AGENT_DIR=$agent_dir \
        NANOGPT_API_KEY=$PI_NANOGPT_API_KEY \
        GIT_EXTERNAL_DIFF=$HOME/.pi/agent/local/git-plain-diff \
        command pi $argv[2..-1]
    set -l status_code $status
    popd
    return $status_code
end
