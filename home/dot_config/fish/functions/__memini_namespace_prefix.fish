function __memini_namespace_prefix --on-variable PWD --description "Scope memini memories under work/ inside ~/Development/Work"
    set -l work_root "$HOME/Development/Work"

    if test "$PWD" = "$work_root"; or string match -q -- "$work_root/*" "$PWD"
        set -gx MEMINI_NAMESPACE_PREFIX work
    else if set -q MEMINI_NAMESPACE_PREFIX
        set -e MEMINI_NAMESPACE_PREFIX
    end
end
