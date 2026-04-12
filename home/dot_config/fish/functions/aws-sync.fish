function aws-sync --description "Discover AWS roles and generate ~/.aws/config"
    set -l INVENTORY "$HOME/.aws/inventory.json"
    set -l CONFIG_FILE "$HOME/.aws/config"
    set -l SSO_OP_PATH "op://Work/AWS/WBD"

    mkdir -p "$HOME/.aws"
    echo "[]" >"$INVENTORY"

    function add_entry
        set -l inv $argv[1]
        set -l org $argv[2]
        set -l type $argv[3]
        set -l name $argv[4]
        set -l id $argv[5]
        set -l role $argv[6]
        set -l arn $argv[7]
        set -l sso_url $argv[8]
        set -l sso_reg $argv[9]

        set -l new_entry (jq -n \
            --arg org "$org" \
            --arg type "$type" \
            --arg name "$name" \
            --arg id "$id" \
            --arg role "$role" \
            --arg arn "$arn" \
            --arg sso_url "$sso_url" \
            --arg sso_reg "$sso_reg" \
            '{org: $org, type: $type, account_name: $name, account_id: $id, role_name: $role, role_arn: $arn, sso_start_url: $sso_url, sso_region: $sso_reg}')
        jq --argjson entry "$new_entry" '. += [$entry]' "$inv" >tmp.json && mv tmp.json "$inv"
    end

    echo "Starting discovery across all organizations..."

    echo "Fetching SSO configuration from 1Password..."
    set -l SSO_START_URL (op read "$SSO_OP_PATH")
    if test -z "$SSO_START_URL"
        echo "Error: Could not fetch SSO Start URL from 1Password path: $SSO_OP_PATH" >&2
        return 1
    end

    for ORG in DSC DTC WB
        echo "Scanning SAML Org: $ORG..."

        set -l tmp_saml (mktemp)
        op run --env-file="$HOME/.aws/saml2aws/$ORG/.env" -- saml2aws --skip-prompt list-roles -a "$ORG" 2>/dev/null >$tmp_saml; or echo "" >$tmp_saml

        if not test -s $tmp_saml
            echo "Warning: No data returned for $ORG" >&2
            rm -f $tmp_saml
            continue
        end

        cat $tmp_saml | awk -v org="$ORG" '
            /^Account: / {
                line = $0; sub(/^Account: /, "", line);
                if (line ~ /\(/) {
                    acc_name = substr(line, 1, index(line, " (") - 1);
                    acc_id = substr(line, index(line, "(") + 1);
                    sub(/\)/, "", acc_id);
                } else {
                    acc_name = line; acc_id = line;
                }
            }
            /^arn:aws:iam/ {
                arn = $1;
                n = split(arn, p, "/");
                role_name = p[n];
                gsub(/\r/, "", acc_name); gsub(/\r/, "", acc_id); gsub(/\r/, "", role_name);
                print acc_name "|" acc_id "|" role_name "|" arn
            }
        ' | while read -l line
            set -l fields (string split "|" "$line")
            add_entry "$INVENTORY" "$ORG" "saml" $fields[1] $fields[2] $fields[3] $fields[4] "" ""
        end

        rm -f $tmp_saml
    end

    echo "Scanning SSO Org: WBD..."
    set -l tmp_sso (mktemp)
    granted sso generate --sso-region us-east-1 "$SSO_START_URL" 2>/dev/null >$tmp_sso

    cat $tmp_sso | awk -v org="WBD" '
        /^\[profile / {
            p_str = $0; gsub(/\[profile |\]/, "", p_str);
            split(p_str, p_parts, "/");
            acc_name = p_parts[1];
        }
        /granted_sso_start_url/  { sso_url = $3 }
        /granted_sso_region/     { sso_reg = $3 }
        /granted_sso_account_id/ { acc_id = $3 }
        /granted_sso_role_name/  { role_name = $3 }
        /credential_process/ {
            if (acc_name != "") {
                gsub(/\r/, "", acc_name); gsub(/\r/, "", acc_id); gsub(/\r/, "", role_name);
                print acc_name "|" acc_id "|" role_name "|" sso_url "|" sso_reg
            }
        }
    ' | while read -l line
        set -l fields (string split "|" "$line")
        add_entry "$INVENTORY" "WBD" "sso" $fields[1] $fields[2] $fields[3] "" $fields[4] $fields[5]
    end

    rm -f $tmp_sso

    set -l count (jq 'length' "$INVENTORY")
    echo "Discovery Complete. Found $count roles."
    echo "----------------------------------------------------"

    echo "Generating $CONFIG_FILE..."

    begin
        echo "# Generated AWS Config - "(date)
        echo "[default]"
        echo "region = us-east-1"
        echo "output = json"
    end >"$CONFIG_FILE"

    jq -c '.[]' "$INVENTORY" | while read -l row
        set -l ORG (echo "$row" | jq -r '.org')
        set -l TYPE (echo "$row" | jq -r '.type')
        set -l NAME (echo "$row" | jq -r '.account_name')
        set -l ID (echo "$row" | jq -r '.account_id')
        set -l ROLE (echo "$row" | jq -r '.role_name')
        set -l PROFILE "$ORG/$NAME/$ROLE"

        echo "" >>"$CONFIG_FILE"
        echo "[profile $PROFILE]" >>"$CONFIG_FILE"

        if test "$TYPE" = "sso"
            set -l URL (echo "$row" | jq -r '.sso_start_url')
            set -l REG (echo "$row" | jq -r '.sso_region')
            echo "granted_sso_start_url = $URL" >>"$CONFIG_FILE"
            echo "granted_sso_region = $REG" >>"$CONFIG_FILE"
            echo "granted_sso_account_id = $ID" >>"$CONFIG_FILE"
            echo "granted_sso_role_name = $ROLE" >>"$CONFIG_FILE"
            echo "common_fate_generated_from = aws-sso" >>"$CONFIG_FILE"
            echo "credential_process = granted credential-process --auto-login --profile $PROFILE" >>"$CONFIG_FILE"
        else
            set -l ARN (echo "$row" | jq -r '.role_arn')
            set -l ENV_FILE "$HOME/.aws/saml2aws/$ORG/.env"
            echo "region = us-east-1" >>"$CONFIG_FILE"
            echo "credential_process = op run --env-file='$ENV_FILE' -- saml2aws login --credential-process --idp-account='$ORG' --role='$ARN'" >>"$CONFIG_FILE"
        end
    end

    echo "Success! Config generated with $count profiles."
end
