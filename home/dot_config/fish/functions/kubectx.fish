function kubectx --description "Kubernetes Context Switcher"
    set -l K8S_INV "$HOME/.kube/inventory.json"
    set -l KUBE_CLUSTER_DIR "$HOME/.kube/clusters"

    if not test -f "$K8S_INV"
        echo "Error: Inventory missing. Run k8s-sync first." >&2
        return 1
    end

    # Unset mode
    if test "$argv[1]" = "-u"
        set -e KUBECONFIG
        set -e AWS_PROFILE
        echo "✘ Context unset."
        return 0
    end

    set -l MATCH ""

    if set -q argv[1]
        # Direct cluster name
        set MATCH (jq -r --arg input "$argv[1]" '.[] | select(.cluster_name == $input)' "$K8S_INV")
        if test -z "$MATCH"
            echo "Error: Cluster \"$argv[1]\" not found in inventory." >&2
            return 1
        end
    else
        # Interactive fzf selection
        set -l SELECTED_ROW (jq -r '.[] | "\(.cluster_name) | \(.account_name) | \(.account_id)"' "$K8S_INV" | sort | column -t -s '|' | fzf --ansi --prompt="Cluster> " --height=40% --layout=default)

        if test -z "$SELECTED_ROW"
            return 0
        end

        set -l CLUSTER_NAME (echo "$SELECTED_ROW" | awk '{print $1}')
        set MATCH (jq -r --arg name "$CLUSTER_NAME" '.[] | select(.cluster_name == $name)' "$K8S_INV")
    end

    set -l FIN_CLUSTER (echo "$MATCH" | jq -r '.cluster_name')
    set -l FIN_PROFILE (echo "$MATCH" | jq -r '.aws_profile')
    set -l KUBE_PATH "$KUBE_CLUSTER_DIR/$FIN_CLUSTER.yaml"

    if not test -f "$KUBE_PATH"
        echo "Error: Kubeconfig file not found at $KUBE_PATH. Run k8s-sync again." >&2
        return 1
    end

    set -gx KUBECONFIG "$KUBE_PATH"
    set -gx AWS_PROFILE "$FIN_PROFILE"
    echo "✔ Context: $FIN_CLUSTER ($FIN_PROFILE)"
    assume "$FIN_PROFILE"
end
