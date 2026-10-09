function § --description "One shot: a fish command, or a short answer, for a request in plain words"
    # `§ list all pods in kube-system`, or `§` alone to type a request that has quotes in it.
    # Asks a small model once through Pi with no session, memory, extensions or shell tool. A
    # command runs only after you confirm it; a question about the web gets a short answer and
    # its source. ONESHOT_MODEL=provider/id:thinking overrides the model.
    set -l request (string join ' ' -- $argv)
    if test -z "$request"
        read -P (set_color brblack)'? '(set_color normal) request; or return 1
        test -n "$request"; or return 1
    end

    set -l model (__oneshot_model)
    set -l prompt 'You answer one request from Jan in his terminal, once. There is no conversation and no follow-up.

Either propose one shell command, or give a short answer. You cannot run commands yourself; Jan runs the command after reading it.

- Something to do or inspect on this machine, a Kubernetes cluster, git or GitHub: a command. His shell is fish 4 on macOS (Apple Silicon), so write fish syntax: (cmd) or $(cmd) for substitution, set for variables, no bash-only constructs. Prefer kubectl, flux, talosctl, helm, gh, git, jq, yq, rg, fd, eza, bat and curl, and the simplest form that does the job (flux get over kubectl piped to jq). For Kubernetes, all namespaces (-A) unless the request names one. One line, with pipes, ; or and/or. Read-only when the request allows it. Never invent flags.
- A fact from the web (a version, documentation, how something works): use web_search or fetch_content, then answer in at most 6 lines of plain text, no markdown, with the source URL.

Reply with exactly one JSON object and nothing else, either
{"command": "...", "explain": "one short sentence", "changes": true}
where changes is true when the command creates, modifies or deletes anything and false otherwise, or
{"answer": "...", "source": "URL, or empty"}

Current directory: '(prompt_pwd -D 99)

    isatty stderr; and printf '%s… %s%s' (set_color brblack) $model (set_color normal) >&2
    set -l err (mktemp)
    set -l out (OPENCODE_API_KEY=$PI_OPENCODE_API_KEY MINIMAX_API_KEY=$PI_MINIMAX_API_KEY command pi -p \
        --no-session -ne -nc -ns -np --no-themes --offline \
        -e $HOME/.pi/agent/npm/node_modules/pi-web-access/dist/index.js --tools web_search,fetch_content \
        --model $model --system-prompt "$prompt" "Request: $request" </dev/null 2>$err | string collect)
    set -l pi_status $pipestatus[1]
    isatty stderr; and printf '\r\e[K' >&2

    set -l json (string match -r '(?s)\{.*\}' -- $out)
    if test -z "$json"; or not printf '%s' $json | jq -e . >/dev/null 2>&1
        set_color red
        echo "no usable answer from $model (pi exit $pi_status)" >&2
        set_color normal
        test -n "$out"; and echo $out >&2
        string match -v -e 'No models match pattern' <$err | tail -n 5 >&2
        rm -f $err
        return 1
    end
    rm -f $err

    set -l answer (printf '%s' $json | jq -r '.answer // empty' | string collect)
    if test -n "$answer"
        echo $answer
        set -l source (printf '%s' $json | jq -r '.source // empty')
        test -n "$source"; and set_color brblack; and echo $source; and set_color normal
        return 0
    end

    set -l cmd (printf '%s' $json | jq -r '.command // empty' | string collect)
    test -n "$cmd"; or begin
        echo $out >&2
        return 1
    end
    set -l explain (printf '%s' $json | jq -r '.explain // empty')
    set -l changes (printf '%s' $json | jq -r '.changes // false')

    echo
    printf '  %s\n' (printf '%s' $cmd | fish_indent --ansi)
    set_color brblack
    test -n "$explain"; and echo "  $explain"
    set_color normal
    set -l ask '  run? [Y/n/e] '
    if test "$changes" = true
        set_color red
        echo '  changes things'
        set_color normal
        set ask '  run? [y/N/e] '
    end

    read -n 1 -P $ask reply; or return 1
    switch (string lower -- "$reply")
        case e
            read --shell --command $cmd -P '  › ' cmd; or return 1
        case y
        case ''
            test "$changes" = true; and return 1
        case '*'
            return 1
    end
    test -n "$cmd"; or return 1
    builtin history append -- $cmd
    eval $cmd
end

# The first model whose subscription has room, cheapest and fastest first. These calls are
# tiny, so only a subscription at 95% or a known limit is skipped (pi-usage's cache).
function __oneshot_model
    if set -q ONESHOT_MODEL
        echo $ONESHOT_MODEL
        return
    end
    set -l usage $HOME/.pi/agent/usage.json
    for pick in opencode-go=opencode-go/deepseek-v4.1-flash:low chatgpt=openai/gpt-6.1-sol:low minimax=minimax/MiniMax-M2.7-highspeed:low
        set -l pool (string split -m1 = $pick)
        set -l full (jq -r --arg p $pool[1] --argjson now (date +%s) '
            def t: .[0:19] + "Z" | fromdateiso8601;
            .[$p] as $u
            | if $u == null then false
              elif (($u.limitedUntil // "") != "" and ($u.limitedUntil | t) > $now) then true
              else ([$u.windows[]? | select((.resetsAt // "") == "" or (.resetsAt | t) > $now) | .usedPct] | max // 0) >= 95
              end' $usage 2>/dev/null)
        if test "$full" != true
            echo $pool[2]
            return
        end
    end
    echo minimax/MiniMax-M2.7-highspeed:low
end
