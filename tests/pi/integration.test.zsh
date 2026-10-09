#!/usr/bin/env zsh
#
# End-to-end checks with the real Pi binary, the real profile extension and the
# installed pi-memini package, in a throwaway HOME. Model and memory requests use
# tests/pi/mock_gateway.py; only owned extensions are loaded. Memory is off by
# default; quiet memory is checked against the mock below. Needs `pi` and memini
# in ~/.pi/agent/npm. No package installation or bridge loading occurs.

emulate -L zsh
setopt no_unset pipe_fail

[[ -n ${PI_TEST_GUARD_DIR-} && -n ${PI_TEST_NETWORK_LOG-} && -n ${NODE_OPTIONS-} ]] || { print "Run via tests/pi/run.sh (offline guard required)"; exit 1 }
repo=${0:A:h:h:h}
src=$repo/home
SB=$(mktemp -d "${TMPDIR:-/tmp}/pi-integration.XXXXXX"); SB=${SB:A}
H=$SB/home
# Detached usage refreshers may still be writing into the sandbox at the end.
trap 'kill ${gw_pid-} 2>/dev/null; pkill -f "usage-refresh.ts $SB" 2>/dev/null; sleep 0.5; if [[ ${PI_TEST_KEEP-} == 1 ]]; then print "sandbox kept: $SB"; else rm -rf $SB; fi' EXIT

failures=0 passes=0
ok() { (( passes++ )); print -r -- "  ok   $1" }
bad() { (( failures++ )); print -r -- "  FAIL $1${2:+ — $2}" }
check() { [[ $2 == $3 ]] && ok $1 || bad $1 "got '$2', want '$3'" }
contains() { [[ $2 == *$3* ]] && ok $1 || bad $1 "missing '$3' in: ${2[1,400]}" }

real_pi=(${${(f)"$(whence -pa pi)"}:#$HOME/.local/bin/pi})
real_pi=${real_pi[1]-}
[[ -n $real_pi ]] || { print "pi is not installed"; exit 1 }

# --- sandbox HOME from the chezmoi source ------------------------------------------

python3 $repo/tests/pi/mock_gateway.py $SB & gw_pid=$!
for _ in {1..50}; do [[ -s $SB/gateway.port ]] && break; sleep 0.1; done
GW=http://127.0.0.1:$(<$SB/gateway.port)/v1

mkdir -p $H/.local/bin $H/.pi/shared $H/.pi/agent/claude $H/plain
cp $src/dot_local/bin/executable_pi $H/.local/bin/pi && chmod +x $H/.local/bin/pi
ln -s pi $H/.local/bin/pi-profile
cp -R $src/dot_pi/shared/. $H/.pi/shared/
# modify_ scripts read the current file on stdin; render them as first-time applies.
render() { (cd $src && chezmoi execute-template < $1) > $SB/render.zsh && zsh $SB/render.zsh < /dev/null > $2 }
render dot_pi/private_agent/modify_settings.json.tmpl $H/.pi/agent/settings.json
render dot_pi/private_agent/modify_claude-bridge.json.tmpl $H/.pi/agent/claude-bridge.json
cp $src/dot_pi/private_agent/private_claude/settings.json $H/.pi/agent/claude/
# Native mock models exercise usage visibility offline.
mock() { jq -nc --arg id $1 '{id: $id, name: $id, reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 8192, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}' }
jq -n --arg gw $GW --argjson models "[$(mock opencode-go/deepseek-v4.1-flash),$(mock mock/tools)]" \
  '{providers: {litellm: {baseUrl: $gw, api: "openai-completions", apiKey: "LITELLM_API_KEY", models: $models}}}' > $H/.pi/agent/models.json
# Keep dependencies local, but never discover/install the managed npm packages.
cp -R $HOME/.pi/agent/npm $H/.pi/agent/npm
jq '.packages = [] | .extensions = []' $H/.pi/agent/settings.json > $SB/s && mv $SB/s $H/.pi/agent/settings.json
mkdir -p $H/Work/repo && git -C $H/Work/repo init -q
# Projects trusted up front so print mode never waits on a trust prompt.
jq '. + {defaultProjectTrust: "always"}' $H/.pi/agent/settings.json > $SB/s && mv $SB/s $H/.pi/agent/settings.json

PATH_SB=$PI_TEST_GUARD_DIR:$H/.local/bin:${real_pi:h}:/usr/bin:/bin:/opt/homebrew/bin
# pi_in DIR [VAR=VAL...] -- ARGS...: launch through the launcher (or `--raw` for the bare binary).
pi_in() {
  local dir=$1; shift
  local -a extra=() cmd=($H/.local/bin/pi)
  while [[ $1 != -- ]]; do
    case $1 in --raw) cmd=($real_pi) ;; *) extra+=($1) ;; esac
    shift
  done
  shift
  seed
  : > $SB/gateway.log
  ( cd $dir && env -i HOME=$H PWD=$dir PATH=$PATH_SB TERM=dumb PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
      NODE_OPTIONS=$NODE_OPTIONS PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG \
      HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 \
      MEMINI_BASE_URL=${GW%/v1} PI_MEMINI=off LITELLM_API_KEY=dummy-litellm $extra $cmd --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files -e $H/.pi/shared/extensions/profile -e $H/.pi/shared/extensions/memory "$@" ) >$SB/stdout 2>$SB/stderr < /dev/null
}
requests() { jq -r '.model' $SB/gateway.log 2>/dev/null | paste -sd, - }
out() { cat $SB/stdout $SB/stderr }
gw() { print -r -- $1 > $SB/gateway.json }

seed() { jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '["claude", "codex", "opencode-go", "minimax"] | map({key: ., value: {sub: ., label: ., windows: [{name: "week", usedPct: 99}], fetchedAt: $now}}) | from_entries' > $H/.pi/agent/usage.json }

# --- Native models and usage ----------------------------------------------------------------------

print "native models and usage"
gw '{}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash --thinking low; st=$?
check "native model answers through LiteLLM" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
contains "native output" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "native effort is honoured" "$(jq -r .reasoning_effort $SB/gateway.log | head -1)" low
personal_session=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | head -1)

pi_in $H/plain -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash; st=$?
check "usage exhaustion never replaces an explicit native model" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
gw '{"opencode-go/deepseek-v4.1-flash": {"status": 429, "message": "GoUsageLimitError: limit reached"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash; st=$?
check "quota error stays on its native model" "$(requests)" "opencode-go/deepseek-v4.1-flash"
check "quota error marks the model's subscription limited" "$(jq -r '."opencode-go".limitedUntil != null' $H/.pi/agent/usage.json)" true
rm -f $H/.pi/agent/usage.json
gw '{}'

# --- Unwrapped launches and cross-profile sessions --------------------------------------------------

print "bypass and sessions"
pi_in $H/Work/repo AI_PROFILE=personal --raw -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash; st=$?
check "bare pi in a Work repo (inherited Personal scope) sends nothing" "$(requests)" ""
contains "…and explains" "$(out)" "needs Work memory scope; restart with `pi`"

pi_in $H/Work/repo -- -p "PI-SMOKE hello" --session $personal_session --model litellm/opencode-go/deepseek-v4.1-flash
check "Personal session cannot continue with Work memory" "$(requests)" ""
contains "…and explains the memory boundary" "$(out)" "recorded with personal memory"
pi_in $H/Work/repo -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash
work_session=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | head -1)
pi_in $H/plain -- -p "PI-SMOKE hello" --session $work_session --model litellm/opencode-go/deepseek-v4.1-flash
check "Work session cannot continue with Personal memory" "$(requests)" ""
contains "…and explains the memory boundary" "$(out)" "recorded with work memory"

script() { gw "$(jq -cn --argjson s "$1" '{"mock/tools": {script: $s}}')" }
print "commit attribution"
repo=$H/plain/commits
git init -q $repo
script "$(jq -cn --arg c 'git -c user.name=t -c user.email=t@example.com -c commit.gpgSign=false commit -q --allow-empty -m "fix: x" -m "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>" && echo committed' '[{tool: "bash", args: {command: $c}}]')"
pi_in $repo -- -p "PI-SMOKE commit" --model litellm/mock/tools
contains "an AI co-author trailer is stripped from git commit" "$(out)" "RESULT: committed"
check "…and the commit has no trailer" "$(git -C $repo log -1 --format=%B | grep -c -i co-authored)" 0
script "$(jq -cn --arg c $'git -c user.name=t -c user.email=t@example.com -c commit.gpgSign=false commit -q --allow-empty -m $\'fix: y\\n\\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\'' '[{tool: "bash", args: {command: $c}}]')"
pi_in $repo -- -p "PI-SMOKE commit" --model litellm/mock/tools
contains "…one it cannot strip is blocked with the reason" "$(out)" "Commits must not credit an AI model or agent"
check "…and nothing was committed" "$(git -C $repo log --format=%s | grep -c 'fix: y')" 0

print "quiet memory"
gw '{}'
pi_in $H/plain PI_MEMINI=on MEMINI_API_KEY=dummy-memory MEMINI_BASE_URL=${GW%/v1} MEMINI_CAPTURE=0 MEMINI_SESSION_DIGEST=0 -- --mode json -p "PI-SMOKE investigate synthetic evidence" --model litellm/opencode-go/deepseek-v4.1-flash
# Print mode subscribes after startup briefing; check recall events here, both messages in persistence below.
check "automatic recall is hidden before message_start" "$(jq -s '[.[] | select(.type == "message_start" and .message.customType == "memini-recall") | .message.display] | length == 1 and all(. == false)' $SB/stdout)" true
check "full memory context still reaches the model" "$(jq -r 'select(.model == "opencode-go/deepseek-v4.1-flash") | .memory_context' $SB/gateway.log | head -1)" true
latest=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | head -1)
check "hidden memory remains in persisted session" "$(jq -s '[.[] | select(.type == "custom_message" and (.customType == "memini-recall" or .customType == "memini-briefing")) | .display] | length == 2 and all(. == false)' $latest)" true
check "explicit memory tools remain available" "$(jq -c 'select(.model == "opencode-go/deepseek-v4.1-flash") | [.tools[] | select(startswith("memory_"))] | length > 0' $SB/gateway.log | head -1)" true

print "\n$passes passed, $failures failed"
(( failures == 0 ))
