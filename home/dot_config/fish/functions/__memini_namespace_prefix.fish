function __memini_namespace_prefix --on-variable PWD --description "Select a registered project namespace or the shared scratch namespace"
    # Runner identity wins even when a task or child changes directories.
    if set -q PI_PROJECT; and set -q MEMINI_NAMESPACE
        set -e MEMINI_NAMESPACE_PREFIX
        return
    end
    set -e MEMINI_NAMESPACE_PREFIX
    set -l selected ("$HOME/.local/bin/agent" namespace 2>/dev/null)
    if test $status -eq 0; and test -n "$selected"
        set -gx MEMINI_NAMESPACE "$selected"
    else
        # No guess: on the work host any fallback could be a personal namespace.
        set -e MEMINI_NAMESPACE
        echo "memini: agent namespace failed, MEMINI_NAMESPACE unset" >&2
    end
end
