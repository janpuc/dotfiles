# The aether server's fish (Linux only, see .chezmoiignore): the Pi launcher ahead of mise's tools,
# which include the real `pi`. `mise activate` puts tool directories first again in interactive
# shells, so the `pi` function names the launcher explicitly, as it does on the laptop.
fish_add_path --prepend "$HOME/.local/bin" "$HOME/.local/share/mise/shims"
status is-interactive; and mise activate fish | source
