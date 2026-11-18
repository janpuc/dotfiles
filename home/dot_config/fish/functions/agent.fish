function agent --description "Start or focus a project agent in Rex"
    if test (count $argv) -ne 1
        echo 'Usage: agent <project>|up|ls' >&2
        return 2
    end
    command python3 "$HOME/.local/bin/agent-run" --launch $argv
end
