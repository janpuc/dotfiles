# The first argument is a project under ~/Security (implied inside one); pi's options anywhere.
complete -c pi-sec -f -n "__fish_is_first_arg" -a "(path basename $HOME/Security/*/)" -d project
complete -c pi-sec -w pi
