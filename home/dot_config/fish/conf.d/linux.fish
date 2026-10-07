# The aether server's fish (Linux only, see .chezmoiignore): the Pi launcher and mise's tools.
fish_add_path --prepend "$HOME/.local/share/mise/shims" "$HOME/.local/bin"
status is-interactive; and mise activate fish | source
