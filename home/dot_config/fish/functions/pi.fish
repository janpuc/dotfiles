function pi --wraps pi --description "Pi, through ~/.pi/agent/local/bin/pi and its Pi environment"
    # The wrapper sets the bridge's Claude config and token, the PI_-cached provider keys, the
    # plain git diff and OSC 52 copies. It is first on PATH already; naming it here keeps it first
    # in interactive shells on aether too, where mise puts its own tool paths in front.
    $HOME/.pi/agent/local/bin/pi $argv
end
