#!/usr/bin/env zsh
#
# Behavioural tests for home/dot_local/bin/executable_pi (pi / pi-profile).
# Everything runs in a throwaway HOME with synthetic Work/Personal trees, dummy
# credentials, a fake `pi` that records what it was given, and a mock memini
# handshake server. Nothing touches the real ~/.pi, Keychain or network.

emulate -L zsh
setopt no_unset pipe_fail

[[ -n ${PI_TEST_GUARD_DIR-} && -n ${PI_TEST_NETWORK_LOG-} ]] || { print "Run via tests/pi/run.sh (offline guard required)"; exit 1 }
repo=${0:A:h:h:h}
T=$(mktemp -d "${TMPDIR:-/tmp}/pi-launcher-test.XXXXXX")
T=${T:A}
H=$T/home
trap 'kill ${mock_pid-} 2>/dev/null; rm -rf $T' EXIT

failures=0 passes=0
ok() { (( passes++ )); print -r -- "  ok   $1" }
bad() { (( failures++ )); print -r -- "  FAIL $1${2:+ — $2}" }
check() { [[ $2 == $3 ]] && ok $1 || bad $1 "got '$2', want '$3'" }

# --- sandbox -------------------------------------------------------------------

mkdir -p $H/.local/bin $T/realbin $H/Work/team $H/Work2/x \
  $H/Workshop/y $H/elsewhere $H/outside $H/plain
cp $repo/home/dot_local/bin/executable_pi $H/.local/bin/pi
chmod +x $H/.local/bin/pi
ln -s pi $H/.local/bin/pi-profile

# The fake real pi records its pid, args and environment.
cat > $T/realbin/pi <<'EOF'
#!/bin/zsh
print -r -- $$ > $FAKE_PI_OUT.pid
print -rl -- "$@" > $FAKE_PI_OUT.args
env > $FAKE_PI_OUT.env
[[ ${1-} == --sleep ]] && sleep 30
exit ${FAKE_PI_EXIT:-0}
EOF
chmod +x $T/realbin/pi

g() { git -c user.name=t -c user.email=t@example.com -c init.defaultBranch=main "$@" >/dev/null 2>&1 }
mkrepo() { mkdir -p $1 && g -C $1 init && g -C $1 commit --allow-empty -m init && { [[ -z ${2-} ]] || g -C $1 remote add origin $2 } }
mkrepo $H/Work/team/api git@git.example.com:corp/api.git
mkdir -p $H/Work/team/api/src/deep
mkrepo $H/Development/home-ops git@github.com:me/home-ops.git
mkrepo $H/outside/repo
mkrepo $H/Work2/x/repo
g -C $H/Work/team/api worktree add -b wt $H/elsewhere/api-wt
ln -s $H/Work/team/api $H/link-to-api
ln -s $H/outside/repo $H/Work/linked-outside

# --- mock memini ---------------------------------------------------------------------

cat > $T/mock.py <<'EOF'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
T = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(f"{T}/handshake.log", "a") as f:
            f.write(json.dumps({"auth": self.headers.get("Authorization"), "home": self.headers.get("X-Memini-Home"), "body": json.loads(body)}) + "\n")
        reply = open(f"{T}/handshake.json").read() if os.path.exists(f"{T}/handshake.json") else None
        if reply is None:
            # Echo the client's own resolution like the real server would without pins.
            p = json.loads(body)["project"]
            base = p.get("remote_url", "").rstrip("/").split("/")[-1].removesuffix(".git") or p.get("toplevel_basename") or p["cwd_basename"]
            ns = p.get("env_namespace") or (p.get("env_namespace_prefix") + "/" + base if p.get("env_namespace_prefix") else base)
            reply = json.dumps({"namespace": ns, "namespace_source": "env" if p.get("env_namespace") else "remote", "read_set": [{"namespace": ns, "origin": "primary"}, {"namespace": "personal/jan", "origin": "home"}]})
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(reply.encode())
srv = HTTPServer(("127.0.0.1", 0), H)
open(f"{T}/port", "w").write(str(srv.server_port))
srv.serve_forever()
EOF
python3 $T/mock.py $T & mock_pid=$!
for _ in {1..50}; do [[ -s $T/port ]] && break; sleep 0.1; done
MOCK=http://127.0.0.1:$(<$T/port)

TPATH=$PI_TEST_GUARD_DIR:$H/.local/bin:$T/realbin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin

# run DIR [VAR=VAL...] -- CMD ARGS...: run the launcher from DIR with a clean env.
run() {
  local dir=$1; shift
  local -a extra=()
  while [[ $1 != -- ]]; do extra+=($1); shift; done; shift
  rm -f $T/out.*(N)
  ( cd $dir && env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PWD=$dir PATH=$TPATH TERM=dumb FAKE_PI_OUT=$T/out \
      MEMINI_BASE_URL=$MOCK MEMINI_API_KEY=dummy-memini MEMINI_HOME=personal/jan \
      LITELLM_API_KEY=dummy-litellm LITELLM_BASE_URL=https://litellm.example \
      ANTHROPIC_API_KEY=dummy-anthropic OPENAI_API_KEY=dummy-openai \
      OPENROUTER_API_KEY=dummy-openrouter AWS_PROFILE=work-aws CLAUDECODE=1 \
      PI_OPENCODE_API_KEY=dummy-go PI_MINIMAX_API_KEY=dummy-mm PI_OPENAI_API_KEY=dummy-openai \
      $extra "$@" ) 2>$T/stderr
}
envv() { sed -n "s/^$1=//p" $T/out.env 2>/dev/null }
has() { grep -q "^$1=" $T/out.env 2>/dev/null && print yes || print no }

# --- profile selection -----------------------------------------------------------------

print "profile selection"
run $H/plain -- pi
check "plain dir → personal" "$(envv AI_PROFILE)" personal
check "personal agent dir" "$(envv PI_CODING_AGENT_DIR)" $H/.pi/agent
check "personal claude dir" "$(envv CLAUDE_CONFIG_DIR)" $H/.pi/agent/claude
check "non-repo personal → homelab/scratch" "$(envv MEMINI_NAMESPACE)" homelab/scratch

run $H/Development/home-ops -- pi
check "Development repo → personal" "$(envv AI_PROFILE)" personal
check "Development repo → homelab prefix" "$(envv MEMINI_NAMESPACE_PREFIX)" homelab
check "Development repo → no fixed namespace" "$(has MEMINI_NAMESPACE)" no

run $H/outside/repo -- pi
check "repo outside Development → no prefix" "$(has MEMINI_NAMESPACE_PREFIX)" no
check "repo outside Development → no namespace" "$(has MEMINI_NAMESPACE)" no

run $H/Work/team/api/src/deep -- pi
check "nested Work path → work" "$(envv AI_PROFILE)" work
check "Work → work prefix" "$(envv MEMINI_NAMESPACE_PREFIX)" work
check "Work keeps memini key" "$(envv MEMINI_API_KEY)" dummy-memini
check "Work keeps read-only home overlay" "$(envv MEMINI_HOME)" personal/jan
check "ANTHROPIC_API_KEY scrubbed (Work)" "$(has ANTHROPIC_API_KEY)" no
check "enclosing Claude Code marker scrubbed" "$(has CLAUDECODE)" no

run $H/Work -- pi
check "Work root itself → work" "$(envv AI_PROFILE)" work

for d in $H/Work2/x/repo $H/Workshop/y; do
  run $d -- pi
  check "similar name ${d#$H/} → personal" "$(envv AI_PROFILE)" personal
done
check "personal keeps LITELLM_API_KEY" "$(envv LITELLM_API_KEY)" dummy-litellm
check "personal gets the OpenCode Go key under Pi's name" "$(envv OPENCODE_API_KEY)" dummy-go
check "personal gets the MiniMax key under Pi's name" "$(envv MINIMAX_API_KEY)" dummy-mm
check "ANTHROPIC_API_KEY scrubbed (Personal)" "$(has ANTHROPIC_API_KEY)" no
check "OPENAI_API_KEY scrubbed (Personal)" "$(has OPENAI_API_KEY)" no

if [[ -d $H/work ]]; then
  run $H/work/team/api -- pi
  check "case-folded path on APFS → work" "$(envv AI_PROFILE)" work
fi

run $H/link-to-api -- pi
check "symlink into Work → work" "$(envv AI_PROFILE)" work
run $H/Work/linked-outside -- pi
check "Work-tree symlink pointing outside → work (logical PWD)" "$(envv AI_PROFILE)" work

run $H/elsewhere/api-wt -- pi
check "linked worktree of a Work repo → work" "$(envv AI_PROFILE)" work
check "linked worktree → work memory prefix" "$(envv MEMINI_NAMESPACE_PREFIX)" work

# --- conflicting inherited environment ------------------------------------------------

print "conflicting environment"
run $H/Work/team/api MEMINI_NAMESPACE=homelab/x MEMINI_NAMESPACE_PREFIX=homelab -- pi
check "inherited homelab namespace dropped" "$(has MEMINI_NAMESPACE)" no
check "inherited prefix replaced" "$(envv MEMINI_NAMESPACE_PREFIX)" work

run $H/plain AI_PROFILE=work -- pi
check "child of a Work session stays Work" "$(envv AI_PROFILE)" work
run $H/Work/team/api AI_PROFILE=personal -- pi
check "Work signals beat AI_PROFILE=personal" "$(envv AI_PROFILE)" work

# --- obsolete model flag ---------------------------------------------------------

run $H/Work/team/api -- pi --personal-models; st=$?
check "obsolete model flag refused before Pi starts" "$st/$([[ -e $T/out.pid ]] && print ran || print not-run)/$(grep -c 'personal models everywhere; Work only changes memory scope' $T/stderr)" 78/not-run/1

# --- exec semantics ------------------------------------------------------------------------

print "arguments, exit status, signals"
run $H/plain FAKE_PI_EXIT=42 -- pi -p "two words" '$HOME' "it's" ''; st=$?
check "exit status passes through" $st 42
print -rl -- -p "two words" '$HOME' "it's" '' > $T/expected.args
check "arguments pass through verbatim" "$(cmp -s $T/expected.args $T/out.args && print same || print differ)" same
rm -f $T/out.*(N)
( cd $H/plain && exec env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PATH=$TPATH FAKE_PI_OUT=$T/out MEMINI_BASE_URL=$MOCK MEMINI_API_KEY=k $H/.local/bin/pi --sleep ) 2>/dev/null &
bg=$!
for _ in {1..50}; do [[ -s $T/out.pid ]] && break; sleep 0.1; done
check "launcher execs pi in place (same pid)" "$(<$T/out.pid)" $bg
kill -TERM $bg; wait $bg; st=$?
check "SIGTERM reaches pi" $st 143

# --- memini scope gate ----------------------------------------------------------------------

print "memini scope"
rm -f $T/handshake.log $T/handshake.json
run $H/Work/team/api -- pi
check "Work handshake ok" "$(envv PI_MEMINI_STATE)" "ok: work/api (remote)"
check "handshake sends the key in a header" "$(jq -r .auth $T/handshake.log | head -1)" "Bearer dummy-memini"
check "handshake sends the work prefix" "$(jq -r .body.project.env_namespace_prefix $T/handshake.log | head -1)" work
check "key not in process args" "$(grep -c dummy-memini $T/out.args)" 0
print '{"namespace":"homelab/api","namespace_source":"pin","pin":{"key":"remote:corp/api"},"read_set":[{"namespace":"homelab/api","origin":"primary"}]}' > $T/handshake.json
run $H/Work/team/api -- pi; st=$?
check "Work pinned to homelab is refused" $st 78
check "…before pi starts" "$([[ -e $T/out.pid ]] && print ran || print not-run)" not-run
check "…naming the pin" "$(grep -c 'pin remote:corp/api' $T/stderr)" 1
print '{"namespace":"work/api","namespace_source":"remote","read_set":[{"namespace":"work/api","origin":"primary"},{"namespace":"homelab","origin":"link"},{"namespace":"personal/jan","origin":"home"}]}' > $T/handshake.json
run $H/Work/team/api -- pi; st=$?
check "Work read set linking homelab is refused" $st 78
print '{"namespace":"homelab/home-ops","namespace_source":"pin","read_set":[{"namespace":"homelab/home-ops","origin":"primary"},{"namespace":"work/api","origin":"link"}]}' > $T/handshake.json
run $H/Development/home-ops -- pi; st=$?
check "Personal read set reaching work/* is refused" $st 78
run $H/Work/team/api PI_MEMINI=off -- pi; st=$?
check "PI_MEMINI=off starts without memory" $st 0
check "…with no key" "$(has MEMINI_API_KEY)" no
check "…and an unroutable endpoint" "$(envv MEMINI_BASE_URL)" http://127.0.0.1:9
check "…marked off for the extension" "$(envv PI_MEMINI_STATE)" "off: PI_MEMINI=off"
rm -f $T/handshake.json $T/handshake.log
run $H/Work/team/api -- pi install npm:x
check "subcommands skip the handshake" "$([[ -e $T/handshake.log ]] && print called || print skipped)" skipped
run $H/Work/team/api MEMINI_BASE_URL=http://127.0.0.1:9 -- pi; st=$?
check "memini down → still starts" $st 0
check "…memory off after handshake failure" "$(envv PI_MEMINI_STATE | cut -d: -f1)/$(has MEMINI_API_KEY)/$(envv MEMINI_BASE_URL)" "off/no/http://127.0.0.1:9"
check "…and warns" "$(grep -c 'memini off' $T/stderr)" 1

# --- project config that would loosen the bridge or switch billing ----------------------------

print "project config"
mkdir -p $H/Development/home-ops/.claude
print '{"apiKeyHelper":"echo sk-test"}' > $H/Development/home-ops/.claude/settings.json
run $H/Development/home-ops -- pi; st=$?
check "project apiKeyHelper refused (would bill the API)" $st 78
rm -r $H/Development/home-ops/.claude

# --- credentials cache ----------------------------------------------------------------------------

print "credential cache"
mkdir -p $H/.local/state/ai
# Same format ai-sync writes (fish `string escape`).
cat > $H/.local/state/ai/credentials.fish <<'EOF'
set -gx MEMINI_API_KEY 'cached-memini'
set -gx LITELLM_API_KEY 'cached-lite\'llm'
EOF
rm -f $T/out.*(N)
( cd $H/plain && env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PATH=$TPATH FAKE_PI_OUT=$T/out MEMINI_BASE_URL=$MOCK $H/.local/bin/pi ) 2>/dev/null
check "personal imports memini key from the ai-sync cache" "$(envv MEMINI_API_KEY)" cached-memini
check "personal imports litellm key (fish escaping kept)" "$(envv LITELLM_API_KEY)" "cached-lite'llm"
( cd $H/Work/team/api && env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PATH=$TPATH FAKE_PI_OUT=$T/out MEMINI_BASE_URL=$MOCK $H/.local/bin/pi ) 2>/dev/null
check "Work imports the memini key" "$(envv MEMINI_API_KEY)" cached-memini
check "Work imports the same subscription keys" "$(envv LITELLM_API_KEY)" "cached-lite'llm"

# --- misc ---------------------------------------------------------------------------------------------

print "misc"
out=$(cd $H/elsewhere/api-wt && env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PATH=$TPATH MEMINI_BASE_URL=$MOCK MEMINI_API_KEY=k $H/.local/bin/pi-profile 2>/dev/null)
check "pi-profile reports the worktree owner" "$(print -r -- $out | grep -c "owner $H/Work/team/api")" 1
check "pi-profile reports the reason" "$(print -r -- $out | sed -n 's/^reason=//p')" repo
( cd $H/plain && env -i HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost,::1 PI_TEST_NETWORK_LOG=$PI_TEST_NETWORK_LOG HOME=$H PATH=$H/.local/bin:/usr/bin:/bin:/opt/homebrew/bin/jq-only $H/.local/bin/pi ) 2>$T/stderr; st=$?
check "missing real pi → clear error" "$st/$(grep -c 'not on PATH' $T/stderr)" 78/1

print "\n$passes passed, $failures failed"
(( failures == 0 ))
