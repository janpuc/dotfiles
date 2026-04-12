function k8s-sync --description "Discover EKS clusters and generate kubeconfigs"
    set -l AWS_INV "$HOME/.aws/inventory.json"
    set -l K8S_INV "$HOME/.kube/inventory.json"
    set -l PREFS "$HOME/.kube/role-preferences.json"
    set -l KUBE_CLUSTER_DIR "$HOME/.kube/clusters"

    set -l OP_BASE_PATH "op://Work/K8S"
    set -l SOURCES bolt_eks.json disco_eks.json hbo_eks.json
    set -l ROLE_PRIORITY GtSustainingEngineering

    mkdir -p "$KUBE_CLUSTER_DIR"
    if not test -f "$PREFS"
        echo "{}" >"$PREFS"
    end
    echo "[]" >"$K8S_INV"

    echo "Starting K8s Discovery & Config Generation..."

    for FILENAME in $SOURCES
        echo "Fetching $FILENAME from 1Password..."
        set -l RAW_FILE_DATA (op read "$OP_BASE_PATH/$FILENAME" 2>/dev/null; or echo "")

        if test -z "$RAW_FILE_DATA" -o "$RAW_FILE_DATA" = "[]"
            echo "  ! Skipping $FILENAME (empty or not found)"
            continue
        end

        set -l TYPE "eks"
        if string match -q "*anthos*" "$FILENAME"
            set TYPE "anthos"
        else if string match -q "*metal*" "$FILENAME"
            set TYPE "bare-metal"
        end

        echo "$RAW_FILE_DATA" | jq -c '.[]' | while read -l row
            set -l ACC_ID (echo "$row" | jq -r '.account_id')
            set -l EKS_NAME (echo "$row" | jq -r '.eks_name')
            set -l REGION (echo "$row" | jq -r '.region')

            # Find matching AWS profiles for this account ID
            set -l PROFILES (jq -r --arg id "$ACC_ID" '.[] | select(.account_id == $id) | "\(.org)/\(.account_name)/\(.role_name)"' "$AWS_INV")
            set -l COUNT (echo "$PROFILES" | string match -vr '^$' | wc -l | string trim)

            if test "$COUNT" -eq 0
                continue
            end

            set -l SELECTED_PROFILE ""

            if test "$COUNT" -eq 1
                set SELECTED_PROFILE "$PROFILES"
            else
                # Check if we have a saved preference
                set -l PREF (jq -r --arg eks "$EKS_NAME" '.[$eks]' "$PREFS")
                if test "$PREF" != "null"
                    set SELECTED_PROFILE "$PREF"
                else
                    # Try priority roles
                    for priority_role in $ROLE_PRIORITY
                        set -l MATCH (echo "$PROFILES" | grep "/$priority_role\$" | head -n1)
                        if test -n "$MATCH"
                            set SELECTED_PROFILE "$MATCH"
                            break
                        end
                    end

                    if test -z "$SELECTED_PROFILE"
                        echo "  ? No tiered match for $EKS_NAME ($ACC_ID). Select role:"
                        # fzf reads from terminal even when stdin is a pipe
                        set SELECTED_PROFILE (echo "$PROFILES" | fzf --height 15% --reverse --header "Role for $EKS_NAME" < /dev/tty)
                    end

                    if test -n "$SELECTED_PROFILE"
                        jq --arg eks "$EKS_NAME" --arg prof "$SELECTED_PROFILE" '.[$eks] = $prof' "$PREFS" >tmp.json && mv tmp.json "$PREFS"
                    end
                end
            end

            if test -z "$SELECTED_PROFILE"
                continue
            end

            # Determine display alias
            set -l ALIAS (echo "$row" | jq -r '.alias')
            if test "$ALIAS" = "NA" -o -z "$ALIAS"
                set ALIAS (jq -r --arg id "$ACC_ID" '.[] | select(.account_id == $id) | .account_name' "$AWS_INV" | head -n1)
                if test -z "$ALIAS"
                    set ALIAS "$ACC_ID"
                end
            end

            # Add to inventory
            set -l NEW_ENTRY (jq -n \
                --arg eks "$EKS_NAME" \
                --arg prof "$SELECTED_PROFILE" \
                --arg reg "$REGION" \
                --arg name "$ALIAS" \
                --arg id "$ACC_ID" \
                --arg type "$TYPE" \
                '{cluster_name: $eks, aws_profile: $prof, region: $reg, account_name: $name, account_id: $id, cluster_type: $type}')
            jq --argjson entry "$NEW_ENTRY" '. += [$entry]' "$K8S_INV" >tmp.json && mv tmp.json "$K8S_INV"

            # Generate kubeconfig for EKS clusters
            set -l KUBE_PATH "$KUBE_CLUSTER_DIR/$EKS_NAME.yaml"
            if test "$TYPE" = "eks" -a ! -f "$KUBE_PATH"
                echo "  > Creating config for $EKS_NAME..."
                aws eks update-kubeconfig --name "$EKS_NAME" --region "$REGION" --profile "$SELECTED_PROFILE" --kubeconfig "$KUBE_PATH" < /dev/null
                or echo "    FAILED to create config for $EKS_NAME"
            end
        end
    end

    set -l total (jq 'length' "$K8S_INV")
    echo "----------------------------------------------------"
    echo "K8s Sync Complete! Total: $total clusters."
end
