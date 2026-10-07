#!/usr/bin/env zsh
#
# Live smoke test with the real credentials (ai-sync cache): LiteLLM through
# personal/fast, and memini recall/capture/isolation/compaction for Personal and
# for Work (via --personal-models, so it also runs without the enterprise login).
#
#   tests/pi/smoke.zsh            Personal + Work-override checks
#   tests/pi/smoke.zsh --claude   also personal/daily and work/daily through
#                                 pi-claude-bridge (after both `pi-profile login`s)
#   tests/pi/smoke.zsh --sweep    only delete leftover pi-smoke-* namespaces
#
# Each run works in a temp git repo whose fake origin (example.invalid/pi-smoke-<id>)
# makes memini derive throwaway namespaces: pi-smoke-<id> (Personal) and
# work/pi-smoke-<id> (Work). Nothing reads those, and both are deleted at the end.
# They must not be the real scratch namespaces: memini's promote tick re-upserts
# memories it listed before a delete (and distils new "fact" rows from them), so a
# few rows can reappear minutes after cleanup. `--sweep` removes such stragglers.

emulate -L zsh
setopt no_unset pipe_fail

mode=${1-}
here=${0:A:h}
failures=0 passes=0
ok() { (( passes++ )); print -r -- "  ok   $1" }
bad() { (( failures++ )); print -r -- "  FAIL $1${2:+ — $2}" }

[[ -n ${MEMINI_API_KEY-} ]] || { print "MEMINI_API_KEY is not set; run from fish (ai-sync cache) or run ai-sync"; exit 1 }
base=${MEMINI_BASE_URL:-https://memini.janpuc.com}
# api METHOD PATH NAMESPACE [JSON] — the key goes through curl's stdin config, never argv.
api() {
  local -a data=(); [[ -n ${4-} ]] && data=(--data-binary $4 -H 'Content-Type: application/json')
  print -r -- "header = \"Authorization: Bearer $MEMINI_API_KEY\"" |
    curl -fsS -m 20 -K - -X $1 -H "X-Memini-Namespace: $3" -H "X-Memini-Home: personal/jan" $data "$base$2"
}
drop_namespace() { local n=$(api DELETE /v1/namespaces $1 | jq -r .deleted); print "  cleanup: $1 ($n memories)" }

if [[ $mode == --sweep ]]; then
  for ns in ${(f)"$(api GET /v1/namespaces personal/jan | jq -r '.namespaces[] | select(test("^(work/)?pi-smoke-[0-9a-f]{8}$"))')"}; do
    drop_namespace $ns
  done
  exit 0
fi

with_claude=0; [[ $mode == --claude ]] && with_claude=1
id=$(uuidgen | tr -d - | cut -c1-8 | tr A-Z a-z)
tag=pi-smoke-$id
personal_ns=$tag
work_ns=work/$tag
personal_word=ZEBRA-${id[-4,-1]:u}
work_word=OTTER-${id[-4,-1]:u}
dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-smoke.XXXXXX"); dir=${dir:A}
git -C $dir init -q && git -C $dir remote add origin https://example.invalid/$tag.git

cleanup() {
  drop_namespace $personal_ns
  drop_namespace $work_ns
  # Transcripts of the smoke sessions: Pi's stores and the bridge's Claude dirs.
  local enc=--${${dir#/}//\//-}-- cenc=-${${dir#/}//[\/.]/-}
  rm -rf $HOME/.pi/agent/sessions/$enc $HOME/.pi/profiles/work/agent/sessions/$enc \
    $HOME/.pi/agent/claude/projects/$cenc $HOME/.pi/profiles/work/agent/claude/projects/$cenc
  rm -rf $dir
}
trap cleanup EXIT

# run [launcher args...] PROMPT: one print-mode turn in $dir, JSON events to $dir/events.
run() { ( cd $dir && $HOME/.local/bin/${1} ${@[2,-1]} --mode json ) > $dir/events 2>$dir/stderr < /dev/null }
answer() { jq -r 'select(.type == "message_end" and .message.role == "assistant") | [.message.content[]? | select(.type == "text") | .text] | join(" ")' $dir/events | tail -1 }
routed() { jq -r 'select(.type == "message_end" and .message.role == "assistant") | "\(.message.provider)/\(.message.model)"' $dir/events | tail -1 }
recalled() { jq -r 'select(.type == "message_end" and .message.role == "custom" and (.message.customType | test("memini"))) | .message.content | if type == "string" then . else ([.[]? | .text? // empty] | join(" ")) end' $dir/events }
captured() { api GET "/v1/memories?limit=200" $1 | jq '[.memories[] | select(.metadata.format == "turn" and .metadata.source == "pi")] | length' }

print "namespaces ($tag)"
# Never write fixtures unless both launches resolve to the throwaway namespaces.
p=$(cd $dir && $HOME/.local/bin/pi-profile | sed -n 's/^memini=//p')
w=$(cd $dir && $HOME/.local/bin/pi-profile --work | sed -n 's/^memini=//p')
[[ $p == "ok: $personal_ns "* ]] && ok "Personal resolves to $personal_ns" || { bad "Personal namespace" "$p"; exit 1 }
[[ $w == "ok: $work_ns "* ]] && ok "Work resolves to $work_ns" || { bad "Work namespace" "$w"; exit 1 }
api POST /v1/memories $personal_ns "$(jq -cn --arg t $tag --arg w $personal_word '{content: "Pi smoke test (\($t)): the personal pi smoke-test codeword is \($w). It is only used to verify that memory recall reaches the model.", tags: [$t]}')" >/dev/null && ok "synthetic personal memory" || bad "create personal memory"
api POST /v1/memories $work_ns "$(jq -cn --arg t $tag --arg w $work_word '{content: "Pi smoke test (\($t)): the work pi smoke-test codeword is \($w). It is only used to verify that memory recall reaches the model.", tags: [$t]}')" >/dev/null && ok "synthetic work memory" || bad "create work memory"

q_personal="What is the personal pi smoke-test codeword for $tag? Answer with the codeword only."
q_work="What is the work pi smoke-test codeword for $tag? Answer with the codeword only."

print "personal ($personal_ns, personal/fast)"
run pi -p $q_personal --model personal/fast
[[ $(answer) == *$personal_word* ]] && ok "recall reached the model ($(routed))" || bad "personal recall" "answer: $(answer) / stderr: $(head -c 300 $dir/stderr)"
[[ $(recalled) == *$personal_word* ]] && ok "pi-memini injected the memory as read-only context" || bad "recall injection" "$(recalled | head -c 300)"
[[ $(recalled) != *$work_word* ]] && ok "no Work memory in the Personal context" || bad "Work memory leaked into Personal"

print "work override ($work_ns on personal models)"
run piw --personal-models -p $q_work --model personal/fast
[[ $(answer) == *$work_word* ]] && ok "Work recall reached the model ($(routed))" || bad "work recall" "answer: $(answer) / stderr: $(head -c 300 $dir/stderr)"
grep -q 'PERSONAL models' $dir/stderr && ok "override announced" || bad "override announcement"
run piw --personal-models -p "What is the personal pi smoke-test codeword for $tag? If it is not in your context, answer UNKNOWN." --model personal/fast
[[ $(recalled) != *$personal_word* && $(answer) != *$personal_word* ]] && ok "Personal memory not visible from Work" || bad "Personal memory visible in Work" "$(answer)"

print "capture and compaction"
sleep 3
(( $(captured $personal_ns) > 0 )) && ok "turns captured into $personal_ns" || bad "no capture in $personal_ns"
(( $(captured $work_ns) > 0 )) && ok "turns captured into $work_ns" || bad "no capture in $work_ns"
# Compaction and resume, driven over RPC (print mode cannot run /compact). A small
# keepRecentTokens gives a short test conversation something to summarise.
mkdir -p $dir/.pi && print '{"compaction":{"keepRecentTokens":200}}' > $dir/.pi/settings.json
summary=$(cd $dir && python3 $here/rpc_compact.py $q_personal -- $HOME/.local/bin/pi --mode rpc --approve --model personal/fast)
file=$(print -r -- $summary | jq -r '.session_file // empty')
if [[ -n $file && -f $file ]]; then
  [[ $(print -r -- $summary | jq -r .compacted) == true ]] && ok "session compacted over RPC" || bad "compaction did not run" "$(print -r -- $summary | jq -r .compact_error)"
  [[ $(print -r -- $summary | jq -r .after) == *$personal_word* ]] && ok "recall works after compaction" || bad "recall after compaction" "$(print -r -- $summary | jq -r .after)"
  count() { jq -s --arg t $1 '[.[] | select(.type == "custom_message" and .customType == $t)] | length' $file }
  b1=$(count memini-briefing)
  print "  after compaction: $b1 briefing(s), $(count memini-recall) recall(s), $(jq -s '[.[] | select(.type == "compaction")] | length' $file) compaction(s)"
  (( b1 == 2 )) && ok "briefing re-sent once after compaction" || bad "briefing count after compaction" "$b1 (want 2: start + after compaction)"
  ( cd $dir && $HOME/.local/bin/pi --session $file -p "Say OK." --model personal/fast ) >/dev/null 2>&1 < /dev/null
  (( $(count memini-briefing) == b1 )) && ok "resume adds no duplicate briefing" || bad "duplicate briefing on resume" "$(count memini-briefing)"
else
  bad "RPC compaction run" "$summary"
fi
rm -rf $dir/.pi

if (( with_claude )); then
  print "claude bridge"
  run pi -p $q_personal --model personal/daily
  [[ $(routed) == claude-bridge/* && $(answer) == *$personal_word* ]] && ok "personal/daily via claude-bridge sees memini context" || bad "personal bridge" "$(routed): $(answer) / $(head -c 300 $dir/stderr)"
  run piw -p $q_work --model work/daily
  [[ $(routed) == claude-bridge/* && $(answer) == *$work_word* ]] && ok "work/daily via the enterprise seat sees work memory" || bad "work bridge" "$(routed): $(answer) / $(head -c 300 $dir/stderr)"
fi

print "\n$passes passed, $failures failed"
(( failures == 0 ))
