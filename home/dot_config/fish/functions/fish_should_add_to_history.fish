function fish_should_add_to_history
    # fish's own rule, which this function replaces: nothing that starts with a space.
    string match -qr '^\s' -- $argv[1]; and return 1
    # A § request stays out; § adds the command it runs instead.
    string match -qr '^§(\s|$)' -- $argv[1]; and return 1
    return 0
end
