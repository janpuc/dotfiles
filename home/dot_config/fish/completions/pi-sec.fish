# The first argument is a project under ~/Security; the rest go to pi.
complete -c pi-sec -f -n "__fish_is_first_arg" -a "(path basename $HOME/Security/*/)" -d project
complete -c pi-sec -n "not __fish_is_first_arg" -w pi
