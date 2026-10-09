#!/usr/bin/env zsh
#
# End-to-end checks with the real Pi binary, the real profile extension and the
# installed pi-claude-bridge/pi-memini packages, in a throwaway HOME. LiteLLM is
# replaced by tests/pi/mock_gateway.py; the bridge has no Claude login there, so
# its requests fail the way a missing login does. Memory is off (PI_MEMINI=off);
# quiet memory is checked below. Needs `pi` installed and the packages present
# in ~/.pi/agent/npm (git forks: ~/.pi/agent/git).

emulate -L zsh
setopt no_unset pipe_fail

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
# Native mock models exercise usage visibility and worker loadouts offline.
mock() { jq -nc --arg id $1 --argjson img $2 '{id: $id, name: $id, reasoning: true, input: (if $img then ["text","image"] else ["text"] end), contextWindow: 1000000, maxTokens: 8192, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}' }
jq --arg gw $GW --argjson astra "$(mock gpt-6-astra false)" --argjson extra "[$(mock opencode-go/deepseek-v4.1-flash false),$(mock minimax/MiniMax-M3 true),$(mock mock/tools false)]" \
  '.providers.litellm.baseUrl = $gw | .providers.litellm.models += $extra
    | .providers.openai = {baseUrl: $gw, api: "openai-completions", apiKey: "$LITELLM_API_KEY", models: [$astra]}' $src/dot_pi/private_agent/models.json > $H/.pi/agent/models.json
ln -s ../shared/agents $H/.pi/agent/agents
cp -R $HOME/.pi/agent/npm $H/.pi/agent/npm
# Forks pinned as git: packages (pi-claude-bridge) install into the agent's git dir.
[[ -d $HOME/.pi/agent/git ]] && cp -R $HOME/.pi/agent/git $H/.pi/agent/git
mkdir -p $H/Work/repo && git -C $H/Work/repo init -q
# Projects trusted up front so print mode never waits on a trust prompt.
jq '. + {defaultProjectTrust: "always"}' $H/.pi/agent/settings.json > $SB/s && mv $SB/s $H/.pi/agent/settings.json

PATH_SB=$H/.local/bin:${real_pi:h}:/usr/bin:/bin:/opt/homebrew/bin
# pi_in DIR [VAR=VAL...] -- ARGS...: launch through the launcher (or `--raw` for the bare binary).
pi_in() {
  local dir=$1; shift
  local -a extra=() cmd=($H/.local/bin/pi)
  while [[ $1 != -- ]]; do
    case $1 in --raw) cmd=($real_pi) ;; *) extra+=($1) ;; esac
    shift
  done
  shift
  : > $SB/gateway.log
  ( cd $dir && env -i HOME=$H PWD=$dir PATH=$PATH_SB TERM=dumb PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
      PI_MEMINI=off LITELLM_API_KEY=dummy-litellm $extra $cmd "$@" ) >$SB/stdout 2>$SB/stderr < /dev/null
}
requests() { jq -r '.model' $SB/gateway.log 2>/dev/null | paste -sd, - }
out() { cat $SB/stdout $SB/stderr }
gw() { print -r -- $1 > $SB/gateway.json }

# --- Native models and usage ----------------------------------------------------------------------

print "native models and usage"
gw '{}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash --thinking low; st=$?
check "native model answers through LiteLLM" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
contains "native output" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "native effort is honoured" "$(jq -r .reasoning_effort $SB/gateway.log | head -1)" low
personal_session=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | head -1)

seed() { jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{"opencode-go": {sub: "opencode-go", label: "OpenCode Go", windows: [{name: "week", usedPct: 99}], fetchedAt: $now}}' > $H/.pi/agent/usage.json }
seed
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
script '[{"tool":"bash","args":{"command":"git push"}}]'; pi_in $H/plain -- -p "PI-SMOKE go" --model litellm/mock/tools
contains "Personal git push is blocked without prompting or pushing" "$(out)" "Needs Jan's approval"

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

# --- advisor and subagents ----------------------------------------------------------------------------

print "advisor and subagents"
script '[{"tool":"advisor","args":{"question":"PI-SMOKE inspect the entry point"}}]'
pi_in $H/plain -- -p "PI-SMOKE ask an advisor" --model litellm/mock/tools
contains "automatic advisor starts with native Astra" "$(out)" 'Advice from astra (openai/gpt-6-astra, high)'
check "advisor uses the shared read-only runner" "$(jq -c 'select(.model == "gpt-6-astra") | .tools' $SB/gateway.log | head -1)" '["find","grep","ls","read"]'
script '[{"tool":"advisor","args":{"question":"PI-SMOKE?","advisor":"fable"}}]'
pi_in $H/plain -- -p "PI-SMOKE ask fable" --model litellm/mock/tools
contains "explicit unavailable Fable is not replaced with Astra" "$(out)" 'fable (claude-bridge/claude-fable-5-1, xhigh): Not logged in'
script '[{"tool":"advisor","args":{"question":"PI-SMOKE?","advisor":"oracle"}}]'
pi_in $H/plain -- -p "PI-SMOKE ask oracle" --model litellm/mock/tools
contains "unknown advisor is explained" "$(out)" 'Advisor oracle is unavailable'
script '[{"tool":"subagent","args":{"agent":"scout","task":"PI-SMOKE find the entry point","model":"litellm/opencode-go/deepseek-v4.1-flash"}}]'
pi_in $H/plain -- -p "PI-SMOKE use the scout" --model litellm/mock/tools
contains "scout subagent runs on its explicitly selected native model" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "…with the scout's tools" "$(jq -c 'select(.model == "opencode-go/deepseek-v4.1-flash") | .tools' $SB/gateway.log | head -1)" '["find","grep","ls","read"]'

print "worker isolation and lifecycle"
script '[{"tool":"subagent","args":{"agent":"worker","task":"PI-SMOKE bounded web lookup","model":"litellm/opencode-go/deepseek-v4.1-flash","tools":["web_search","fetch_content","get_search_content"]}}]'
pi_in $H/plain -- -p "PI-SMOKE delegate" --model litellm/mock/tools
contains "web-only worker loads through the actual Pi CLI" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "…only exact web tools reach its model" "$(jq -c 'select(.model == "opencode-go/deepseek-v4.1-flash") | .tools' $SB/gateway.log)" '["fetch_content","get_search_content","web_search"]'

print 'SENTINEL_PARENT_CONTEXT' > $H/.pi/agent/APPEND_SYSTEM.md
script '[{"tool":"subagent","args":{"agent":"scout","task":"PI-SMOKE inspect only this assignment","model":"litellm/opencode-go/deepseek-v4.1-flash","tools":[]}}]'
pi_in $H/plain -- -p "PI-SMOKE use a tool-free scout" --model litellm/mock/tools
check "empty worker tools means no tools, not default tools" "$(jq -c 'select(.model == "opencode-go/deepseek-v4.1-flash") | .tools' $SB/gateway.log | head -1)" '[]'
check "worker excludes global append-system context" "$(jq -r 'select(.model == "opencode-go/deepseek-v4.1-flash") | .parent_context' $SB/gateway.log | head -1)" false
rm $H/.pi/agent/APPEND_SYSTEM.md
pi_in $H/plain -- -p /test-worker-lifecycle --model litellm/mock/tools -e $src:h/tests/pi/worker-lifecycle.ts
contains "background start/delivery/cancel/tree/shutdown/writer ownership" "$(out)" WORKER-LIFECYCLE-PASS

print "durable worker sessions and UI"
gw '{"opencode-go/deepseek-v4.1-flash":{"delay_ms":250}}'
pi_in $H/plain -- -p /test-worker-durable --model litellm/mock/tools -e $src:h/tests/pi/worker-durable.ts
contains "native worker history survives process exit and live steering/resume" "$(out)" WORKER-DURABLE-PASS
check "resumed request sees its own brief + steering + follow-up, not parent context" "$(jq -s '[.[] | select(.model == "opencode-go/deepseek-v4.1-flash")] | last | (.sentinels | index("WORKER_OWN_HISTORY") != null and index("WORKER_STEER") != null and index("WORKER_RESUME") != null)' $SB/gateway.log)" true
gw '{}'
pi_in $H/plain -- -p /test-worker-ui --model litellm/mock/tools -e $src:h/tests/pi/worker-ui.ts
contains "tasks picker/transcript keys, detail/focus/disposal, safe narrow renders" "$(out)" WORKER-UI-PASS
check "UI regression sends no model requests" "$(requests)" ""

print "context forks and isolated editing/imports"
stage2b=$H/Work/stage2b
mkdir -p $stage2b && git -C $stage2b init -q
print -r -- 'base a' > $stage2b/a.txt; print -r -- 'base b' > $stage2b/b.txt
git -C $stage2b add a.txt b.txt && git -C $stage2b -c user.name=Test -c user.email=test@example.invalid -c commit.gpgSign=false commit -qm 'test baseline'
gw '{}'
pi_in $stage2b PI_TEST_GATEWAY_DIR=$SB -- -p /test-worker-stage2b --model litellm/mock/tools -e $src:h/tests/pi/worker-stage2b.ts
contains "native forks, SDK projection, isolated writers, manual import/conflict, reload and shared-writer lease" "$(out)" WORKER-STAGE2B-PASS
check "fork payload reaches model without memory/system/summary/raw-parent sentinels" "$(jq -s 'any(.[]; .sentinels | index("FORK_PARENT_SENTINEL") != null) and all(.[]; .sentinels | index("FORBIDDEN_MEMORY_SENTINEL") == null and index("FORBIDDEN_SYSTEM_SENTINEL") == null and index("FORBIDDEN_SUMMARY_SENTINEL") == null and index("FORK_PARENT_OLD") == null)' $SB/gateway.log)" true

print "real RPC orphan EOF cleanup"
pi_in $H/plain PI_TEST_ORPHAN_MARKER=$SB/orphan.json -- -p /test-worker-orphan -e $src:h/tests/pi/worker-orphan.ts
if python3 - $SB/orphan.json <<'PY'
import json,os,subprocess,sys,time
pids = json.load(open(sys.argv[1]))
def alive(pid):
    try:
        os.kill(pid,0)
        return not subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip().startswith('Z')
    except ProcessLookupError: return False
try:
    for _ in range(50):
        if not any(alive(pids[k]) for k in ['worker','descendant']): break
        time.sleep(.02)
    assert not any(alive(pids[k]) for k in ['worker','descendant']), 'RPC EOF left an owned descendant before the watchdog tick'
    assert time.time()*1000-pids['started'] < 1900, 'cleanup depended on the 2s watchdog'
finally:
    try: os.killpg(pids['worker'],9)
    except ProcessLookupError: pass
PY
then ok "piped RPC parent death cleans TERM-resistant descendants before the watchdog tick"; else bad "piped RPC orphan EOF cleanup" "$(out)"; fi
check "…orphan fixture makes no model requests" "$(requests)" ""

print "mixed worker/parent tool batches"
for order in worker-first parent-first; do
  : > $H/plain/batch-trace
  batch=$(jq -cn --arg order $order --arg trace $H/plain/batch-trace '
    {tool:"worker",args:{action:"start",agent:"worker",task:"bounded marker writer",model:"litellm/opencode-go/deepseek-v4.1-flash",tools:["bash"],files:[$trace]}} as $worker |
    {tool:"bash",args:{command:("printf '\''parent\\n'\'' >> " + $trace)}} as $parent |
    {"mock/tools":{batch:(if $order == "worker-first" then [$worker,$parent] else [$parent,$worker] end)}}')
  gw $batch
  pi_in $H/plain -- -p "PI-SMOKE mixed batch" --model litellm/mock/tools --no-extensions -e $H/.pi/shared/extensions/profile -e $src:h/tests/pi/worker-batch.ts
  if [[ $order == worker-first ]]; then expected=$'child-start\nchild-end\nparent'; else expected=$'parent\nchild-start\nchild-end'; fi
  check "real agent loop serializes $order without overlapping checkout writers" "$(<$H/plain/batch-trace)" "$expected"
done

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
