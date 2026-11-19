function work-creds --description "Send one temporary AWS profile from hermes to sisyphus"
    if test (count $argv) -ne 1
        echo 'Usage: work-creds <profile>' >&2
        return 1
    end
    python3 "$HOME/.local/bin/work-creds-send" $argv
end
