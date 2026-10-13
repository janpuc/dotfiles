function pi-sec --description "Pi in the security-research profile, in ~/Security/<project>"
    # A separate PI_CODING_AGENT_DIR gives this profile its own settings, models, MCP servers,
    # packages and sessions: no memini, no Claude bridge, no Pi Pocket (see
    # ~/.pi/security/agent/AGENTS.md). It is not a sandbox — Pi still runs as this user.
    #
    # Each project is a directory under ~/Security whose AGENTS.md is its scope; Pi has no --cwd,
    # so it starts from there and reads that file next to the profile's shared rules. A new
    # project gets the scope template and the artefacts/, tools/ and reports/ layout.
    #
    # ai-sync caches the NanoGPT and MiniMax subscription keys under PI_ names; the providers read
    # the plain names, so they stay off in every other tool. Subagents inherit them from this process.
    set -l root $HOME/Security
    set -l agent_dir $HOME/.pi/security/agent

    # Inside a project (or any directory below one) the project is implied, so `pi-sec -c`
    # there continues its latest session. Pi keys sessions by directory, which is why Pi always
    # starts from the project root, never from the subdirectory.
    set -l here (string match -rg '^'(string escape --style=regex -- $root)'/([^/]+)' -- $PWD)
    if test -n "$here"; and begin; test (count $argv) -eq 0; or string match -q -- '-*' $argv[1]; end
        and not contains -- $argv[1] -h --help
        set argv $here $argv
    end

    if test (count $argv) -eq 0; or contains -- $argv[1] -h --help
        echo "Usage: pi-sec <project> [pi arguments…]"
        echo "       pi-sec [pi arguments…]   (inside ~/Security/<project>)"
        echo "Projects in $root:"
        for d in $root/*/
            printf '  %s\n' (basename $d)
        end
        return 0
    end

    set -l project $argv[1]
    if string match -q -- '-*' $project
        echo "pi-sec: name a project first, or run it inside ~/Security/<project>" >&2
        return 1
    end
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
        MINIMAX_API_KEY=$PI_MINIMAX_API_KEY \
        GIT_EXTERNAL_DIFF=$HOME/.pi/agent/local/git-plain-diff \
        command pi $argv[2..-1]
    set -l status_code $status
    popd
    return $status_code
end
