function __omp_profile --on-variable PWD --description "Keep omp on the work profile inside the work tree"
    set -l work_root "$HOME/Development/Work"

    # An omp profile relocates the whole user base to ~/.omp/profiles/<name>,
    # agent.db included — and agent.db is the credential vault. Personal Claude
    # + ChatGPT subs stay in the default profile, the enterprise Claude seat
    # lives in `work`. omp rotates multiple credentials of the same provider id
    # automatically and has no per-project account pin, so separate profiles are
    # the only thing that keeps work turns off the personal sub (and vice
    # versa). Same trigger as __memini_namespace_prefix, so memory namespace and
    # billing flip in lockstep.
    #
    # OMP_PROFILE wins over PI_PROFILE even when set to an empty string, so the
    # personal case must ERASE it, not blank it.
    if test "$PWD" = "$work_root"; or string match -q -- "$work_root/*" "$PWD"
        set -gx OMP_PROFILE work
    else
        set -e OMP_PROFILE
    end
end
