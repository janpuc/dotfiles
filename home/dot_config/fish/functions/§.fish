function § --description "One shot: a fish command, or a short answer, for a request in plain words"
    # `§ list all pods in kube-system`, or `§` alone to type a request that has quotes in it.
    # Asks a small model once through Pi with no session, memory, extensions or shell tool. A
    # command waits for one key: Enter runs it and puts it in history, any other key drops it;
    # red means it changes things. A question about the web gets a short answer and its source.
    # The request stays out of history (fish_should_add_to_history, and atuin's history_filter);
    # the command it runs goes into both.
    # ONESHOT_MODEL=provider/id:thinking overrides the model.
    set -l request (string join ' ' -- $argv)
    if test -z "$request"
        read -P (set_color magenta)'§ '(set_color normal) request; or return 1
        test -n "$request"; or return 1
    end

    set -l prompt 'You answer one request from Jan in his terminal, once. There is no conversation and no follow-up.

Either propose one shell command, or give a short answer. You cannot run commands yourself; Jan runs the command after reading it.

- Something to do or inspect on this machine, a Kubernetes cluster, git or GitHub: a command. His shell is fish 4 on macOS (Apple Silicon), so write fish syntax: (cmd) or $(cmd) for substitution, set for variables, no bash-only constructs. Prefer kubectl, flux, talosctl, helm, gh, git, jq, yq, rg, fd, eza, bat and curl, and the simplest form that does the job (flux get over kubectl piped to jq). For Kubernetes, all namespaces (-A) unless the request names one. One line, with pipes, ; or and/or. Read-only when the request allows it. Never invent flags.
- A fact from the web (a version, documentation, how something works): use web_search or fetch_content, then answer in at most 6 short lines of plain text, no markdown. Put the URL only in source, not in the answer.

Reply with exactly one JSON object and nothing else, either
{"command": "...", "explain": "one short sentence", "changes": true}
where changes is true when the command creates, modifies or deletes anything and false otherwise, or
{"answer": "...", "source": "URL, or empty"}

Current directory: '(prompt_pwd -D 99)

    # Pi runs in the background so a spinner can turn meanwhile.
    set -l out (mktemp)
    set -l err (mktemp)
    OPENCODE_API_KEY=$PI_OPENCODE_API_KEY MINIMAX_API_KEY=$PI_MINIMAX_API_KEY command pi -p \
        --no-session -ne -nc -ns -np --no-themes --offline \
        -e $HOME/.pi/agent/npm/node_modules/pi-web-access/dist/index.js --tools web_search,fetch_content \
        --model (__oneshot_model) --system-prompt "$prompt" "Request: $request" </dev/null >$out 2>$err &
    set -l pid $last_pid
    disown $pid 2>/dev/null
    __oneshot_spin $pid
    set -l reply (string collect <$out)
    set -l json (string match -r '(?s)\{.*\}' -- $reply)

    if test -z "$json"; or not printf '%s' $json | jq -e . >/dev/null 2>&1
        printf '  %s✗ no answer%s\n' (set_color red) (set_color normal) >&2
        set_color brblack
        test -n "$reply"; and printf '    %s\n' $reply >&2
        string match -v -e 'No models match pattern' <$err | tail -n 3 | string replace -r '^' '    ' >&2
        set_color normal
        rm -f $out $err
        return 1
    end
    rm -f $out $err

    # Text is wrapped here, so every line starts in the same column.
    set -l columns 80
    test -n "$COLUMNS"; and set columns $COLUMNS
    set -l width (math "min(max(30, $columns), 104) - 4")
    set -l answer (printf '%s' $json | jq -r '.answer // empty')
    if test -n "$answer"
        set -l source (printf '%s' $json | jq -r '.source // empty')
        # Models still add the URL to the answer now and then; it is shown once, below.
        set answer (string match -v -r '^\s*(Sources?:|https?://\S+\s*$)' -- $answer)
        set -l lines (__oneshot_wrap $width $answer)
        printf '  %s◆%s %s\n' (set_color magenta) (set_color normal) $lines[1]
        for line in $lines[2..]
            test -n "$line"; and printf '    %s\n' $line; or echo
        end
        test -n "$source"; and printf '    %s%s%s\n' (set_color brblack) $source (set_color normal)
        return 0
    end

    set -l cmd (printf '%s' $json | jq -r '.command // empty' | string collect)
    if test -z "$cmd"
        printf '  %s✗ no command%s\n' (set_color red) (set_color normal) >&2
        return 1
    end
    set -l explain (__oneshot_wrap $width (printf '%s' $json | jq -r '.explain // empty'))
    set -l accent magenta
    test (printf '%s' $json | jq -r '.changes // false') = true; and set accent red

    # The suggestion: the command, a dim line saying what it does, and a waiting ⏎.
    set -l lines (printf '%s' $cmd | fish_indent --ansi)
    printf '  %s▸%s %s\n' (set_color $accent) (set_color normal) $lines[1]
    test (count $lines) -gt 1; and printf '    %s\n' $lines[2..]
    for line in $explain
        printf '    %s%s%s\n' (set_color brblack) $line (set_color normal)
    end
    printf '  %s⏎%s ' (set_color $accent) (set_color normal)
    __oneshot_key
    set -l cancelled $status

    # Rows to clear: the waiting line, the explanation, and on cancel the command too.
    set columns (math "max(20, $columns)")
    set -l up (count $explain)
    if test $cancelled -ne 0
        for line in $lines
            set up (math "$up + max(1, ceil((4 + $(string length --visible -- $line)) / $columns))")
        end
    end
    printf '\r\e[K' >&2
    test $up -gt 0; and printf '\e[%dA\r\e[J' $up >&2
    test $cancelled -ne 0; and return 1

    builtin history append -- $cmd
    # atuin's hooks only see what was typed at the prompt, so record this run the way they do.
    set -l atuin_id
    set -q ATUIN_SESSION; and type -q atuin; and set atuin_id (ATUIN_SHELL=fish atuin history start --hook -- $cmd 2>/dev/null)
    eval $cmd
    set -l s $status
    test -n "$atuin_id"; and atuin history end --hook --exit $s -- $atuin_id &>/dev/null
    return $s
end

# Words wrapped to a width, one line per output item; a blank line between paragraphs, never
# two, and none at either end.
function __oneshot_wrap --argument-names width
    set -l out
    set -l blank 0
    for text in $argv[2..]
        if test -z (string trim -- "$text")
            set blank 1
            continue
        end
        test $blank -eq 1 -a (count $out) -gt 0; and set -a out ''
        set blank 0
        set -l line ''
        for word in (string split -n ' ' -- $text)
            if test -z "$line"
                set line $word
            else if test (math (string length --visible -- "$line") + 1 + (string length --visible -- "$word")) -le $width
                set line "$line $word"
            else
                set -a out $line
                set line $word
            end
        end
        set -a out $line
    end
    test (count $out) -gt 0; and printf '%s\n' $out
end

# Braille spinner on stderr until the process ends; quiet when stderr is not a terminal. Keys
# typed meanwhile are not echoed, so they can't break the layout. Raw mode, not just -echo:
# echo off in line mode looks like a password prompt, and Ghostty turns on Secure Keyboard
# Entry for it. One sh process does it all:
# fish resets the terminal modes before each external command it starts, so an `stty` from fish
# would not last.
function __oneshot_spin --argument-names pid
    sh -c '
        pid=$1 color=$2 normal=$3
        [ -t 0 ] && saved=$(stty -g) && stty -echo -icanon
        set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
        while kill -0 "$pid" 2>/dev/null; do
            [ -t 2 ] && printf "\r  %s%s%s" "$color" "$1" "$normal" >&2
            frame=$1; shift; set -- "$@" "$frame"
            sleep 0.08
        done
        [ -t 2 ] && printf "\r\033[K" >&2
        [ -n "$saved" ] && stty "$saved"
        true' sh $pid (set_color magenta) (set_color normal)
end

# One key from the terminal, raw: status 0 for Enter, 1 for any other key (Ctrl-C included)
# or when no key could be read. Keys typed before the suggestion appeared are thrown away
# first, so an early Enter can't run a command unseen; leftover bytes of a multi-byte key
# (arrows) are drained after, so they don't reach the prompt. Without a terminal, an empty line
# from stdin is Enter. One sh process does it all (fish resets terminal modes before each
# external command) and writes the key to a file (an interactive fish runs command
# substitutions without the terminal, so nothing inside one can read a key).
function __oneshot_key
    if not isatty stdin
        read -l line; or return 1
        test -z "$line"
        return
    end
    set -l byte (mktemp)
    sh -c '
        saved=$(stty -g)
        stty -icanon -echo -isig min 0 time 0
        dd bs=4096 count=1 >/dev/null 2>&1
        stty min 1 time 0
        dd bs=1 count=1 2>/dev/null | od -An -tx1
        stty min 0 time 0
        dd bs=64 count=1 >/dev/null 2>&1
        stty "$saved"' >$byte
    set -l key (string trim <$byte | string join '')
    rm -f $byte
    contains -- "$key" 0a 0d
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
