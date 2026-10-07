#!/usr/bin/env zsh
#
# End-to-end checks with the real Pi binary, the real profile extension and the
# installed pi-claude-bridge/pi-memini packages, in a throwaway HOME. LiteLLM is
# replaced by tests/pi/mock_gateway.py; the bridge has no Claude login there, so
# its requests fail the way a missing login does. Memory is off (PI_MEMINI=off);
# memini is covered by smoke.zsh. Needs `pi` installed and the packages present
# in ~/.pi/agent/npm and ~/.pi/profiles/work/agent/npm (chezmoi apply does both).

emulate -L zsh
setopt no_unset pipe_fail

repo=${0:A:h:h:h}
src=$repo/home
SB=$(mktemp -d "${TMPDIR:-/tmp}/pi-integration.XXXXXX"); SB=${SB:A}
H=$SB/home
# Detached usage refreshers may still be writing into the sandbox at the end.
trap 'kill ${gw_pid-} 2>/dev/null; pkill -f "usage-refresh.ts $SB" 2>/dev/null; sleep 0.5; rm -rf $SB' EXIT

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

mkdir -p $H/.local/bin $H/.pi/shared $H/.pi/agent/claude $H/.pi/profiles/work/agent/claude $H/plain
cp $src/dot_local/bin/executable_pi $H/.local/bin/pi && chmod +x $H/.local/bin/pi
ln -s pi $H/.local/bin/piw; ln -s pi $H/.local/bin/pi-profile
cp -R $src/dot_pi/shared/. $H/.pi/shared/
# modify_ scripts read the current file on stdin; render them as first-time applies.
render() { (cd $src && chezmoi execute-template < $1) > $SB/render.zsh && zsh $SB/render.zsh < /dev/null > $2 }
render dot_pi/private_agent/modify_settings.json.tmpl $H/.pi/agent/settings.json
render dot_pi/private_agent/modify_claude-bridge.json.tmpl $H/.pi/agent/claude-bridge.json
render dot_pi/private_profiles/private_work/private_agent/modify_settings.json.tmpl $H/.pi/profiles/work/agent/settings.json
render dot_pi/private_profiles/private_work/private_agent/modify_claude-bridge.json.tmpl $H/.pi/profiles/work/agent/claude-bridge.json
cp $src/dot_pi/private_agent/private_claude/settings.json $H/.pi/agent/claude/
cp $src/dot_pi/private_profiles/private_work/private_agent/private_claude/settings.json $H/.pi/profiles/work/agent/claude/
# The mock gateway stands in for every subscription: OpenCode Go and MiniMax speak their own
# protocols natively, so the sandbox routes the same chain structure through mock models on the
# LiteLLM provider, each tagged with the usage pool the real target draws on. Plus a scripted
# tool-calling model (mock/tools) and a router model (mock/router) for auto.
mock() { jq -nc --arg id $1 --argjson img $2 '{id: $id, name: $id, reasoning: true, input: (if $img then ["text","image"] else ["text"] end), contextWindow: 1000000, maxTokens: 8192, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}' }
jq --arg gw $GW --argjson extra "[$(mock opencode-go/deepseek-v4.1-flash false),$(mock minimax/MiniMax-M3 true),$(mock mock/tools false),$(mock mock/router false)]" \
  '.providers.litellm.baseUrl = $gw | .providers.litellm.models += $extra' $src/dot_pi/private_agent/models.json > $H/.pi/agent/models.json
jq '.profiles.personal.models.fast.chain = [
      {provider: "litellm", model: "opencode-go/deepseek-v4.1-flash", thinking: "low", usage: "opencode-go"},
      {provider: "litellm", model: "minimax/MiniMax-M3", thinking: "low", usage: "minimax"}]
    | .profiles.personal.auto.classifier = {provider: "litellm", model: "mock/router", timeoutMs: 8000}' \
  $src/dot_pi/shared/routing.json > $SB/routing.json
cp $SB/routing.json $H/.pi/shared/routing.json
ln -s ../shared/agents $H/.pi/agent/agents
ln -s ../../../shared/agents $H/.pi/profiles/work/agent/agents
cp -R $HOME/.pi/agent/npm $H/.pi/agent/npm
cp -R $HOME/.pi/profiles/work/agent/npm $H/.pi/profiles/work/agent/npm
mkdir -p $H/Development/Work/repo && git -C $H/Development/Work/repo init -q
# Projects trusted up front so print mode never waits on a trust prompt.
for f in $H/.pi/agent/settings.json $H/.pi/profiles/work/agent/settings.json; do
  jq '. + {defaultProjectTrust: "always"}' $f > $SB/s && mv $SB/s $f
done

PATH_SB=$H/.local/bin:${real_pi:h}:/usr/bin:/bin:/opt/homebrew/bin
# pi_in DIR [VAR=VAL...] -- ARGS...: launch through the launcher (or `--raw` for the bare binary).
pi_in() {
  local dir=$1; shift
  local -a extra=() cmd=($H/.local/bin/pi)
  while [[ $1 != -- ]]; do
    case $1 in --raw) cmd=($real_pi) ;; --piw) cmd=($H/.local/bin/piw) ;; *) extra+=($1) ;; esac
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

# --- Personal ------------------------------------------------------------------------------

print "personal"
gw '{}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/fast; st=$?
check "fast answers through LiteLLM" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
contains "fast output" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "fast sends effort low" "$(jq -r .reasoning_effort $SB/gateway.log | head -1)" low

python3 -c 'import struct,sys,zlib
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
raw = b"".join(b"\0" + b"\xff\x00\x00" * 8 for _ in range(8))
sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))' > $SB/dot.png
pi_in $H/plain -- -p --model personal/fast @$SB/dot.png "PI-SMOKE what is this"; st=$?
check "an image goes to the vision model, not dropped" "$st/$(requests)/$(jq -r .images $SB/gateway.log | head -1)" "0/minimax/MiniMax-M3/true"

pi_in $H/plain -- -p "PI-SMOKE hello"; st=$?
check "daily without a Claude login fails without touching LiteLLM" "$(requests)" ""
contains "…and says how to log in" "$(out)" "pi-profile login"

gw '{"opencode-go/deepseek-v4.1-flash": {"status": 502, "message": "502 Bad Gateway: upstream connect error"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/fast; st=$?
check "LiteLLM failure is not retried by Pi on top of LiteLLM" "$(requests)" "opencode-go/deepseek-v4.1-flash"
contains "…exhausted chain is an actionable error" "$(out)" "no fallback left for personal/fast"

gw '{"bc250-local/qwen3.6-35b-a3b": {"status": 503, "message": "503 service unavailable"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/local; st=$?
check "local never falls back to the cloud" "$(requests)" "bc250-local/qwen3.6-35b-a3b"

# A two-step gateway chain exercises the message_end rewrite: a quota error that Pi
# would not retry becomes a fallback to the next target.
jq '.providers.litellm.failsOverInternally = false
    | .profiles.personal.models.chain2 = {name: "Chain2", level: "low", chain: [
        {provider: "litellm", model: "minimax/MiniMax-M3", thinking: "low"},
        {provider: "litellm", model: "opencode-go/deepseek-v4.1-flash", thinking: "low"}]}' \
  $SB/routing.json > $H/.pi/shared/routing.json
gw '{"minimax/MiniMax-M3": {"status": 404, "message": "model_not_found: The model minimax/MiniMax-M3 does not exist"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/chain2; st=$?
check "an unavailable model (not retried by Pi) falls back to the next target" "$st/$(requests)" "0/minimax/MiniMax-M3,opencode-go/deepseek-v4.1-flash"
latest=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | head -1)
check "…and the provider's own error is kept in the session" "$(jq -r 'select(.customType == "pi-profile-fallback") | .data.error' $latest | head -1 | grep -c model_not_found)" 1
gw '{"minimax/MiniMax-M3": {"status": 429, "message": "insufficient_quota: You exceeded your current quota"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/chain2; st=$?
check "a quota error skips the rest of that provider" "$(( st != 0 ))/$(requests)" "1/minimax/MiniMax-M3"

gw '{"minimax/MiniMax-M3": {"status": 503, "message": "503 service unavailable", "fail_times": 1}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/chain2; st=$?
check "transient error retries the same model once" "$st/$(requests)" "0/minimax/MiniMax-M3,minimax/MiniMax-M3"

gw '{"minimax/MiniMax-M3": {"status": 503, "message": "503 service unavailable"}, "opencode-go/deepseek-v4.1-flash": {"status": 503, "message": "503 service unavailable"}}'
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/chain2; st=$?
n=$(wc -l < $SB/gateway.log | tr -d ' ')
check "retries are bounded and never loop" "$( (( n <= 5 )) && print bounded || print $n)" bounded
check "…ending in a non-zero exit" "$(( st != 0 ))" 1
cp $SB/routing.json $H/.pi/shared/routing.json

# --- usage-aware routing and auto -----------------------------------------------------------------

print "usage and auto"
gw '{}'
seed() { jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson used $1 '{"opencode-go": {sub: "opencode-go", label: "OpenCode Go", windows: [{name: "week", usedPct: $used}], fetchedAt: $now}}' > $H/.pi/agent/usage.json }
seed 99
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/fast; st=$?
check "an exhausted pool is skipped on a new prompt" "$st/$(requests)" "0/minimax/MiniMax-M3"
seed 40
pi_in $H/plain -- -p "PI-SMOKE hello" --model personal/fast; st=$?
check "with headroom the primary is used again" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
rm -f $H/.pi/agent/usage.json
gw '{"mock/router": {"reply": "{\"tier\":\"fast\",\"why\":\"trivial question\"}"}}'
pi_in $H/plain -- -p "PI-SMOKE what does ls -la do in one sentence" --model personal/auto; st=$?
check "auto asks the router, then runs the chosen tier" "$st/$(requests)" "0/mock/router,opencode-go/deepseek-v4.1-flash"
gw '{"mock/router": {"status": 503, "message": "503 service unavailable"}}'
pi_in $H/plain -- -p "PI-SMOKE explain the design" --model personal/auto; st=$?
check "a failing router falls back to the default tier (daily)" "$(requests | cut -d, -f1)" "mock/router"
contains "…whose Claude primary is then tried" "$(out)" "Not logged in"
gw '{"mock/router": {"reply": "{\"tier\":\"deep\"}"}}'
pi_in $H/plain -- -p "yes" --model personal/auto; st=$?
check "a short follow-up skips the router" "$(requests | grep -c mock/router)" 0

# --- Work ---------------------------------------------------------------------------------------

print "work"
gw '{}'
pi_in $H/plain --piw -- -p "PI-SMOKE hello"; st=$?
check "work/daily without the enterprise login sends nothing to LiteLLM" "$(requests)" ""
contains "…and names the Work login" "$(out)" "pi-profile --work login"

# A provider with credentials showing up in Work (here: a stray models.json) must still be unusable.
jq '.providers.litellm.apiKey = "dummy-in-work"' $H/.pi/agent/models.json > $H/.pi/profiles/work/agent/models.json
pi_in $H/plain --piw -- -p "PI-SMOKE hello" --model litellm/opencode-go/deepseek-v4.1-flash; st=$?
check "Work rejects a personal physical model" "$(( st != 0 ))/$(requests)" "1/"
contains "…with the Work policy message" "$(out)" "does not send requests to litellm"

cat > $SB/ext-call.ts <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Simulates an extension making its own model call (summaries, reviews, ...).
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    const m = ctx.modelRegistry.find("litellm", "opencode-go/deepseek-v4.1-flash");
    if (!m) return console.error("EXT-CALL no-model");
    try {
      const r = await ctx.modelRegistry.complete(m, { messages: [{ role: "user", content: "PI-SMOKE ext", timestamp: Date.now() }] } as any);
      console.error(`EXT-CALL ${r.stopReason} ${r.errorMessage ?? ""}`);
    } catch (e) {
      console.error(`EXT-CALL threw ${(e as Error).message}`);
    }
  });
}
EOF
pi_in $H/plain --piw -- -p "PI-SMOKE hello" -e $SB/ext-call.ts; st=$?
check "an extension's own model call is blocked in Work" "$(requests)" ""
contains "…by the request guard" "$(out)" "does not send requests to litellm"

pi_in $H/plain --piw AWS_PROFILE=ambient-test AWS_REGION=eu-west-1 -- -p "PI-SMOKE hello" --model amazon-bedrock/amazon.nova-micro-v1:0; st=$?
check "ambient AWS credentials do not open Bedrock to Work" "$(( st != 0 ))/$(out | grep -c 'does not send requests to amazon-bedrock')" "1/1"
rm $H/.pi/profiles/work/agent/models.json

# --- Unwrapped launches and cross-profile sessions --------------------------------------------------

print "bypass and sessions"
pi_in $H/Development/Work/repo --raw -- -p "PI-SMOKE hello" --model personal/fast; st=$?
check "bare pi in a Work repo (Personal agent dir) sends nothing" "$(requests)" ""
contains "…and explains" "$(out)" "is a Work project but Pi started with the Personal profile"

personal_session=$(ls -t $H/.pi/agent/sessions/*/*.jsonl | tail -1)
pi_in $H/plain --raw AI_PROFILE=work AI_PROFILE_MODELS=work PI_CODING_AGENT_DIR=$H/.pi/profiles/work/agent -- -p "PI-SMOKE hello" --session $personal_session --model work/fast; st=$?
check "a Personal session opened under Work sends nothing" "$(requests)" ""
contains "…and is refused" "$(out)" "recorded under the personal profile"

# --- Work override: Work session on personal models -----------------------------------------------

print "work override"
gw '{}'
pi_in $H/Development/Work/repo -- --personal-models -p "PI-SMOKE hello" --model personal/fast; st=$?
check "override runs Work on a personal model" "$st/$(requests)" "0/opencode-go/deepseek-v4.1-flash"
contains "…and announces it" "$(out)" "PERSONAL models"
wdir=$H/.pi/profiles/work/agent/sessions/--${${${:-$H/Development/Work/repo}#/}//\//-}--
wsess=($wdir/*.jsonl(N))
check "…storing the session in Work's per-cwd store" "${#wsess}" 1
check "…stamped as a Work session on personal models" "$(jq -c 'select(.customType == "pi-profile") | .data' $wsess[1])" '{"profile":"work","models":"personal"}'
pi_in $H/Development/Work/repo -- --personal-models -c -p "PI-SMOKE again" --model personal/fast; st=$?
wsess2=($wdir/*.jsonl(N))
check "-c continues the same Work session" "$st/${#wsess2}" "0/1"
pi_in $H/Development/Work/repo -- -c -p "PI-SMOKE back on the seat"; st=$?
wsess3=($wdir/*.jsonl(N))
check "plain Work -c finds the same session (one history)" "${#wsess3}/$(requests)" "1/"
pi_in $H/plain -- --personal-models -p "PI-SMOKE" --session $wsess[1] --model personal/fast; st=$?
check "a Work session is never continued under Personal" "$(out | grep -c 'launching as Work')" 1

# --- Work tools under the organisation's Claude policy (mirrored by Pi) ---------------------------------

print "work tool policy"
# Synthetic stand-in for the policy Claude Code caches beside the Work login.
cat > $H/.pi/profiles/work/agent/claude/remote-settings.json <<'EOF'
{"permissions": {"defaultMode": "default", "disableBypassPermissionsMode": "disable",
  "allow": ["Bash(git status *)"], "deny": ["Bash(ssh *)", "Read(./.env)", "Read(./.env.*)"], "ask": []}}
EOF
print 'PASSWORD=hunter2' > $H/Development/Work/repo/.env
print 'the password policy lives here' > $H/Development/Work/repo/notes.txt
script() { gw "$(jq -cn --argjson s "$1" '{"mock/tools": {script: $s}}')" }
work_tool() { script $1; pi_in $H/Development/Work/repo ${@[2,-1]} -- --personal-models -p "PI-SMOKE go" --model litellm/mock/tools }
work_tool '[{"tool":"bash","args":{"command":"ssh prod uptime"}}]'
contains "denied command is blocked" "$(out)" "denied by your organisation's Claude policy (Bash(ssh *))"
work_tool '[{"tool":"bash","args":{"command":"git status"}}]'
contains "allowed command runs" "$(out)" "No commits yet"
work_tool '[{"tool":"bash","args":{"command":"echo approved-later"}}]'
contains "unlisted command needs approval (headless: refused)" "$(out)" "needs your approval"
work_tool '[{"tool":"bash","args":{"command":"echo approved-later"}}]' 'PI_PROFILE_APPROVALS={"bash":["echo approved-later"],"tools":[]}'
contains "a session approval inherited from the parent lets it run" "$(out)" "RESULT: approved-later"
work_tool '[{"tool":"read","args":{"path":".env"}}]'
contains "denied file read is blocked" "$(out)" "is denied by your organisation's Claude policy (Read(./.env))"
# grep is not a default tool (subagents and the advisor enable it), so enable it here.
script '[{"tool":"grep","args":{"pattern":"(?i)password","path":"."}}]'
pi_in $H/Development/Work/repo -- --personal-models -p "PI-SMOKE go" --model litellm/mock/tools --tools read,grep,find,ls,bash
o=$(out)
[[ $o == *notes.txt* && $o != *hunter2* && $o == *"1 result(s) hidden"* ]] && ok "search results from denied files are redacted" || bad "search redaction" "${o[1,300]}"
mv $H/.pi/profiles/work/agent/claude/remote-settings.json $SB/policy.bak
work_tool '[{"tool":"bash","args":{"command":"git status"}}]'
contains "without a readable org policy Work tools are off" "$(out)" "Work tools are off until"
mv $SB/policy.bak $H/.pi/profiles/work/agent/claude/remote-settings.json
script '[{"tool":"bash","args":{"command":"echo personal-runs"}}]'
pi_in $H/plain -- -p "PI-SMOKE go" --model litellm/mock/tools
contains "Personal has no org policy" "$(out)" "RESULT: personal-runs"

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
# Point the personal fable advisor at the mock gateway for this test.
jq '.advisors.personal.models.fable = {provider: "litellm", model: "minimax/MiniMax-M3", thinking: "low"}' $SB/routing.json > $H/.pi/shared/routing.json
script '[{"tool":"advisor","args":{"question":"PI-SMOKE should we split this module?","advisor":"fable"}}]'
pi_in $H/plain -- -p "PI-SMOKE please ask fable" --model litellm/mock/tools; st=$?
contains "advisor answers through a separate read-only pi" "$(out)" "Advice from fable (litellm/minimax/MiniMax-M3, low)"
check "…which only had read-only tools" "$(jq -c 'select(.model == "minimax/MiniMax-M3") | .tools' $SB/gateway.log | head -1)" '["find","grep","ls","read"]'
script '[{"tool":"advisor","args":{"question":"PI-SMOKE?","advisor":"oracle"}}]'
pi_in $H/plain -- -p "PI-SMOKE ask oracle" --model litellm/mock/tools
contains "unknown advisor is explained" "$(out)" 'Unknown advisor "oracle"'
cp $SB/routing.json $H/.pi/shared/routing.json
script '[{"tool":"subagent","args":{"agent":"scout","task":"PI-SMOKE find the entry point"}}]'
pi_in $H/plain -- -p "PI-SMOKE use the scout" --model litellm/mock/tools
contains "scout subagent runs on fast" "$(out)" "MOCK-OK opencode-go/deepseek-v4.1-flash"
check "…with the scout's tools" "$(jq -c 'select(.model == "opencode-go/deepseek-v4.1-flash") | .tools' $SB/gateway.log | head -1)" '["bash","find","grep","ls","read"]'

print "\n$passes passed, $failures failed"
(( failures == 0 ))
