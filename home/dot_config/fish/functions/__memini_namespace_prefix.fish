function __memini_namespace_prefix --on-variable PWD --description "Select a registered project namespace or the shared scratch namespace"
    # Runner identity wins even when a task or child changes directories.
    if set -q PI_PROJECT; and set -q MEMINI_NAMESPACE
        set -e MEMINI_NAMESPACE_PREFIX
        return
    end
    # Laptop Work intake keeps the legacy work prefix until phase 2.
    if test "$PWD" = "$HOME/Work"; or string match -q -- "$HOME/Work/*" "$PWD"
        set -gx MEMINI_NAMESPACE_PREFIX work
        set -e MEMINI_NAMESPACE
        return
    end
    set -e MEMINI_NAMESPACE_PREFIX
    set -l selected (python3 "$HOME/.pi/agent/local/memini-namespace.py" 2>/dev/null)
    if test $status -eq 0; and test -n "$selected"
        set -gx MEMINI_NAMESPACE "$selected"
    else
        set -gx MEMINI_NAMESPACE homelab/scratch
    end
end
