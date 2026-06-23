function kubectx --description "Kubernetes Context Switcher"
    set -l K8S_INV "$HOME/.kube/inventory.json"
    set -l KUBE_CLUSTER_DIR "$HOME/.kube/clusters"
    set -l FREC "$HOME/.kube/frecency.json"

    if not test -f "$K8S_INV"
        echo "Error: Inventory missing. Run k8s-sync first." >&2
        return 1
    end
    test -s "$FREC"; or echo "{}" >"$FREC"

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
        # Interactive fzf selection.
        # Columns are ordered cluster_name | account_id | alias, so under
        # --tiebreak=begin a query matching earlier columns wins: cluster name
        # outranks the id, which outranks the alias. All columns stay searchable
        # (the alias is just worth less). Rows are frecency-sorted first and
        # `index` is the final tiebreak, so usage order survives equal matches.
        set -l TAB (printf '\t')
        set -l SELECTED_ROW (jq -r --slurpfile fr "$FREC" '
                ($fr[0] // {}) as $f
                | .[]
                | [ ($f[.cluster_name].n // 0), ($f[.cluster_name].t // 0),
                    .cluster_name, .account_id, .account_name ]
                | @tsv
            ' "$K8S_INV" 2>/dev/null \
            | sort -t "$TAB" -k1,1nr -k2,2nr \
            | cut -f3- \
            | column -t -s "$TAB" \
            | fzf --ansi --prompt="Cluster> " --height=40% --layout=default --tiebreak=begin,index)

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
    __frecency_bump "$FREC" "$FIN_CLUSTER"
    echo "✔ Context: $FIN_CLUSTER ($FIN_PROFILE)"
    assume "$FIN_PROFILE"
end
