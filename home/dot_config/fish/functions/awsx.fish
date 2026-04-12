function awsx --description "AWS Context Switcher"
    set -l INVENTORY "$HOME/.aws/inventory.json"

    if not test -f "$INVENTORY"
        echo "Error: Inventory missing. Run 'aws-sync' first." >&2
        return 1
    end

    # Direct profile argument
    if set -q argv[1]
        set -l MATCH (jq -r --arg input "$argv[1]" \
            '.[] | select("\(.org)/\(.account_name)/\(.role_name)" == $input) | "\(.org)/\(.account_name)/\(.role_name)"' \
            "$INVENTORY" | head -n1)

        if test -n "$MATCH"
            set -gx AWS_PROFILE "$MATCH"
            set -gx AWS_REGION "us-east-1"
            assume "$MATCH"
            return 0
        else
            echo "Error: Profile \"$argv[1]\" not found." >&2
            return 1
        end
    end

    # Interactive selection
    set -l ACCOUNT_ROW (jq -r '
        .[] | "\(.org) | \(if .account_name == "" or .account_name == null then .account_id else .account_name end) | \(.account_id)"
    ' "$INVENTORY" | sort -u | column -t -s '|' | fzf \
        --ansi --prompt="Account> " --height=40% --layout=default)

    if test -z "$ACCOUNT_ROW"
        return 0
    end

    set -l SEL_ORG (echo "$ACCOUNT_ROW" | awk '{print $1}')
    set -l SEL_NAME (echo "$ACCOUNT_ROW" | awk '{print $2}')
    set -l SEL_ID (echo "$ACCOUNT_ROW" | awk '{print $NF}')

    set -l SELECTED_ROLE (jq -r --arg org "$SEL_ORG" --arg id "$SEL_ID" \
        '.[] | select(.org == $org and .account_id == $id) | .role_name' \
        "$INVENTORY" | fzf --ansi --layout=default --prompt="Role for $SEL_NAME> " --height=20%)

    if test -z "$SELECTED_ROLE"
        return 0
    end

    set -l FINAL_PROFILE "$SEL_ORG/$SEL_NAME/$SELECTED_ROLE"

    set -gx AWS_PROFILE "$FINAL_PROFILE"
    set -gx AWS_REGION "us-east-1"
    assume "$FINAL_PROFILE"
end
