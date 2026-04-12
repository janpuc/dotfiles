complete -c awsx -f -a "(jq -r '.[] | \"\(.org)/\(.account_name)/\(.role_name)\"' $HOME/.aws/inventory.json 2>/dev/null)"
