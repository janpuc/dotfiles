function agent --description "Start or focus a project agent in Rex"
    if test (count $argv) -eq 0
        echo 'Usage: agent <project>|up|ls|archive <project>|adopt <project>|ask <project> <text>|reply <project> <id> <text>|restart <project>|all' >&2
        return 2
    end
    if contains -- $argv[1] archive adopt restart
        if test (count $argv) -ne 2
            echo "Usage: agent $argv[1] <project>" >&2
            return 2
        end
    else if test $argv[1] = ask
        if test (count $argv) -lt 3
            echo 'Usage: agent ask <project> <text>' >&2
            return 2
        end
    else if test $argv[1] = reply
        if test (count $argv) -lt 4
            echo 'Usage: agent reply <project> <id> <text>' >&2
            return 2
        end
    else if test (count $argv) -ne 1
        echo 'Usage: agent <project>|up|ls|archive <project>|adopt <project>|ask <project> <text>|reply <project> <id> <text>|restart <project>|all' >&2
        return 2
    end
    command python3 "$HOME/.local/bin/agent-run" --launch $argv
end