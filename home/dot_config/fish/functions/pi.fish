function pi --description "Pi coding agent, Work or Personal memory scope chosen per launch"
    # ~/.local/bin sits behind Homebrew on PATH (moving it forward would also
    # put Hermes' node/npm first), so name the launcher explicitly. It picks
    # only the memory scope from the canonical cwd, then execs the real pi with the same
    # arguments; the status, signals and resume hints are pi's own.
    # `pi-profile` is a symlink to it in ~/.local/bin.
    command ~/.local/bin/pi $argv
end
