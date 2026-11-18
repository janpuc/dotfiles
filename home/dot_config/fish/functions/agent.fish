function agent --description "Start or focus a project agent in Rex"
    if test (count $argv) -eq 0
        echo 'Usage: agent <project>|up|ls|archive <project>|adopt <project>' >&2
        return 2
    end
    if contains -- $argv[1] archive adopt
        if test (count $argv) -ne 2
            echo "Usage: agent $argv[1] <project>" >&2
            return 2
        end
    else if test (count $argv) -ne 1
        echo 'Usage: agent <project>|up|ls|archive <project>|adopt <project>' >&2
        return 2
    end
    command python3 "$HOME/.local/bin/agent-run" --launch $argv
end
