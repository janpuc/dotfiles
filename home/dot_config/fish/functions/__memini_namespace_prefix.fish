function __memini_namespace_prefix --on-variable PWD --description "Keep memini namespaces inside the homelab/work trees automatically"
    set -l dev_root "$HOME/Development"
    set -l work_root "$dev_root/Work"

    # MEMINI_NAMESPACE_PREFIX is prepended to the DERIVED name, giving
    # <prefix>/<repo>. A server-side pin still beats it, so the explicit pins
    # for home-ops / miroir / dotfiles keep winning where they exist; this is
    # what stops a NEW repo landing in a flat, orphaned namespace that inherits
    # nothing.
    if test "$PWD" = "$work_root"; or string match -q -- "$work_root/*" "$PWD"
        set -gx MEMINI_NAMESPACE_PREFIX work
        set -e MEMINI_NAMESPACE
    else if test "$PWD" = "$dev_root"; or string match -q -- "$dev_root/*" "$PWD"
        set -gx MEMINI_NAMESPACE_PREFIX homelab
        set -e MEMINI_NAMESPACE
    else if test -n (git rev-parse --show-toplevel 2>/dev/null; or echo "")
        # A repo outside ~/Development: let it derive its own name unprefixed.
        set -e MEMINI_NAMESPACE_PREFIX
        set -e MEMINI_NAMESPACE
    else
        # Not a repo at all (e.g. an ad-hoc session in ~). Without this the
        # opencode plugin falls back to a flat "opencode" namespace that
        # inherits nothing; park those in one scratch child of homelab instead.
        set -e MEMINI_NAMESPACE_PREFIX
        set -gx MEMINI_NAMESPACE homelab/scratch
    end
end
