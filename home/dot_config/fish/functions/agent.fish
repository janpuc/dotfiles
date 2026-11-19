function agent --description "Start or focus a project agent in Rex"
    # The Python entry point owns help and validation for fish, sh and the laptop client.
    command python3 "$HOME/.local/bin/agent-run" --launch $argv
end
