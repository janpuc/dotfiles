function __frecency_bump --description "Record a usage hit (count + timestamp) in a frecency store" --argument-names file key
    test -n "$key" -a "$key" != null; or return
    test -s "$file"; or echo "{}" >"$file"
    set -l now (date +%s)
    if jq --arg k "$key" --argjson now $now \
            '.[$k].n = ((.[$k].n // 0) + 1) | .[$k].t = $now' "$file" >"$file.tmp" 2>/dev/null
        mv "$file.tmp" "$file"
    else
        rm -f "$file.tmp"
    end
end
