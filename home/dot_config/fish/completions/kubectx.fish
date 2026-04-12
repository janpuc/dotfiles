complete -c kubectx -f -a "(jq -r '.[] | .cluster_name' $HOME/.kube/inventory.json 2>/dev/null)"
complete -c kubectx -s u -d "Unset current context"
