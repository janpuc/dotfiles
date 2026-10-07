function pi --description "Pi coding agent, Work or Personal profile chosen per launch"
    # ~/.local/bin sits behind Homebrew on PATH (moving it forward would also
    # put Hermes' node/npm first), so name the launcher explicitly. It picks
    # the profile from the canonical cwd, then execs the real pi with the same
    # arguments; the status, signals and resume hints are pi's own. `piw` and
    # `pi-profile` are symlinks to it in ~/.local/bin.
    command ~/.local/bin/pi $argv
end
