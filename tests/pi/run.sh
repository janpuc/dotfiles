#!/usr/bin/env zsh
#
# Offline checks for the Pi setup (no real credentials, no network except npm
# for --typecheck):
#   syntax       zsh/fish syntax, JSON validity, chezmoi templates render (incl. the T3 seed)
#   merge        the Personal settings merge keeps one bridge (the git fork)
#   policy       node --test on the memory scope and approvals gate
#   launcher     pi/pi-profile behaviour in a throwaway HOME
#   integration  real Pi + extension + installed packages against a mock gateway
#                (skipped when Pi or the profile packages are not installed)
#   typecheck    tsc --strict against the installed Pi's declarations (--typecheck)
#

emulate -L zsh
setopt no_unset pipe_fail null_glob

here=${0:A:h}
repo=${here:h:h}
src=$repo/home
rc=0
typecheck=0; [[ ${1-} == --typecheck ]] && typecheck=1
step() { print "\n== $1"; shift; "$@" || { rc=1; print "!! failed" } }

syntax() {
  local f t out=$(mktemp)
  zsh -n $src/dot_local/bin/executable_pi || return 1
  for f in $src/dot_config/fish/functions/{pi,__memini_namespace_prefix}.fish; do
    fish --no-execute $f || return 1
  done
  # config.fish renders for the laptop and for the Linux server.
  for os in darwin linux; do
    (cd $src && chezmoi execute-template --override-data "{\"chezmoi\":{\"os\":\"$os\"}}" < dot_config/fish/config.fish.tmpl) > $out && fish --no-execute $out || { rm -f $out; return 1 }
  done
  for f in $src/dot_pi/private_agent/models.json $src/dot_pi/**/settings.json(.); do
    jq empty $f || return 1
  done
  for t in $src/dot_pi/**/modify_*.tmpl $src/.chezmoiscripts/run_onchange_after_configure-pi.sh.tmpl; do
    (cd $src && chezmoi execute-template < $t) > $out && zsh -n $out || { rm -f $out; return 1 }
  done
  # The T3 seed for the aether server is valid JSON with the Pi provider enabled.
  (cd $src && chezmoi execute-template < dot_t3/userdata/create_settings.json.tmpl) | jq -e '.providerInstances.pi.driver == "pi" and .providerInstances.pi.config.enabled' >/dev/null || return 1
  # A first-time apply renders valid JSON with the managed keys.
  for t in $src/dot_pi/**/modify_*.tmpl; do
    (cd $src && chezmoi execute-template < $t) > $out && zsh $out < /dev/null | jq -e 'type == "object"' >/dev/null || { rm -f $out; return 1 }
  done
  rm -f $out
  print "ok"
}

# The Personal settings merge: a pinned git fork replaces the npm release of the same package,
# a filtered entry keeps its filter, and packages added by hand survive.
merge() {
  local out=$(mktemp) got
  (cd $src && chezmoi execute-template < dot_pi/private_agent/modify_settings.json.tmpl) > $out || { rm -f $out; return 1 }
  got=$(print -r -- '{"packages": ["npm:pi-claude-bridge@0.9.1", "npm:@eleboucher/pi-memini@0.7.30", "npm:pi-extra@1.0.0",
    {"source": "git:github.com/janpuc/pi-optchat@0000000"}, "npm:pi-title-glyphs@0.1.1"], "lastChangelogVersion": "1.1.0"}' | zsh $out | jq -c '{
      bridge: [.packages[] | strings | select(test("pi-claude-bridge"))],
      memini: [.packages[] | objects | select(.source | test("pi-memini")) | {source, extensions}],
      packages: (.packages | length),
      extra: ([.packages[] | strings | select(. == "npm:pi-extra@1.0.0")] | length),
      kept: .lastChangelogVersion }')
  rm -f $out
  print -r -- $got | jq -e '(.bridge | length == 1 and (.[0] | startswith("git:github.com/janpuc/pi-claude-bridge@")))
    and .memini == [{"source":"npm:@eleboucher/pi-memini@0.7.34", "extensions":[]}] and .packages == 4 and .extra == 1 and .kept == "1.1.0"' >/dev/null ||
    { print -r -- "unexpected merge: $got"; return 1 }
  print "ok"
}

# Render the actual Linux ignore rules into a temporary source state. Querying the managed
# set proves a future aether apply cannot pick up the Mac-only Pi changes or installer.
platforms() {
  local tmp=$(mktemp -d) os managed
  mkdir -p $tmp/source $tmp/target
  cp -R $src/. $tmp/source/
  print -n '' > $tmp/config.toml
  for os in darwin linux; do
    (cd $src && chezmoi execute-template --override-data "{\"chezmoi\":{\"os\":\"$os\"}}" < .chezmoiignore) > $tmp/source/.chezmoiignore
    managed=$(chezmoi --config $tmp/config.toml --source $tmp/source --destination $tmp/target managed) || { rm -rf $tmp; return 1 }
    if [[ $os == darwin ]]; then
      [[ $managed == *'.pi/shared/extensions/memory/index.ts'* && $managed == *'.pi/agent/settings.json'* ]] || { rm -rf $tmp; return 1 }
    else
      if print -r -- $managed | grep -Eq '^\.pi/(agent/(settings|models)|profiles|shared/(extensions/(profile|subagent|memory)|routing|context/AGENTS|agents/(planner|reviewer|scout|worker)|prompts/|README))|configure-pi'; then
        print 'Linux would receive a held-back Mac Pi resource'; rm -rf $tmp; return 1
      fi
      [[ $managed == *'.pi/agent/claude-bridge.json'* && $managed == *'.pi/shared/personal-policy.json'* ]] || { rm -rf $tmp; return 1 }
    fi
  done
  rm -rf $tmp
  print 'ok: Mac resources managed; existing aether runtime held unchanged; Work excluded on Linux'
}

retry_js() {
  local root
  for root in "$(brew --prefix pi-coding-agent 2>/dev/null)/libexec/lib/node_modules" "$(npm root -g 2>/dev/null)"; do
    [[ -f $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js ]] &&
      { print -r -- $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js; return }
  done
}

policy() { PI_AI_RETRY_JS=$(retry_js) node --test $here/memory-scope.test.ts $here/effects.test.ts $here/gate.test.ts $here/usage.test.ts $here/commit-trailers.test.ts $here/session-lock.test.ts $here/workers.test.ts $here/worker-store.test.ts $here/worker-fork.test.ts $here/worker-worktree.test.ts $here/memory.test.ts }

integration() {
  if ! whence -pa pi | grep -qv "$HOME/.local/bin/pi"; then print "skipped: pi not installed"; return 0; fi
  if [[ ! -d $HOME/.pi/agent/npm || ! -d $HOME/.pi/agent/git/github.com/janpuc/pi-claude-bridge ]]; then
    print "skipped: profile packages not installed (chezmoi apply)"; return 0
  fi
  zsh $here/integration.test.zsh
}

typecheck_ext() {
  local pi_pkg=${$(retry_js)%/node_modules/@earendil-works/pi-ai/dist/utils/retry.js}
  [[ -n $pi_pkg ]] || { print "skipped: installed Pi not found"; return 0 }
  local tmp=$(mktemp -d)
  (cd $tmp && npm init -y >/dev/null && npm install --silent typescript@5 @types/node@24 >/dev/null) || { rm -rf $tmp; return 1 }
  jq -n --arg pi $pi_pkg --arg ext $src/dot_pi/shared/extensions/profile --arg types $tmp/node_modules/@types '{
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
      skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"], typeRoots: [$types], baseUrl: ".",
      paths: { "@earendil-works/pi-coding-agent": ["\($pi)/dist/index.d.ts"],
               "@earendil-works/*": ["\($pi)/node_modules/@earendil-works/*"], typebox: ["\($pi)/node_modules/typebox"] } },
    files: $files }' --argjson files "$(print -rl -- $src/dot_pi/shared/extensions/*/*.ts(.) | jq -R . | jq -s .)" > $tmp/tsconfig.json
  (cd $tmp && ./node_modules/.bin/tsc -p tsconfig.json) && print "ok"
  local st=$?; rm -rf $tmp; return $st
}

step syntax syntax
step merge merge
step platforms platforms
step policy policy
step launcher zsh $here/launcher.test.zsh
step integration integration
(( typecheck )) && step typecheck typecheck_ext
exit $rc
