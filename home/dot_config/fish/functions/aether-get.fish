function aether-get --description "Copy files from aether into ~/Downloads/aether"
    if test (count $argv) -eq 0
        echo 'Usage: aether-get <remote path...>' >&2
        return 1
    end
    set -l dest $HOME/Downloads/aether
    mkdir -p $dest
    for p in $argv
        if not scp -q aether:$p $dest/
            echo "aether-get: could not copy $p" >&2
            return 1
        end
    end
    open $dest
end