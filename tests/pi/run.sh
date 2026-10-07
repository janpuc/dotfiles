#!/usr/bin/env zsh
#
# Offline checks for the Pi setup (no real credentials, no network except npm
# for --typecheck):
#   syntax       zsh/fish syntax, JSON validity, chezmoi templates render
#   policy       node --test on the routing/fallback/memory policy and the Work org-policy mirror
#   launcher     pi/piw/pi-profile behaviour in a throwaway HOME
#   integration  real Pi + extension + installed packages against a mock gateway
#                (skipped when Pi or the profile packages are not installed)
#   typecheck    tsc --strict against the installed Pi's declarations (--typecheck)
#
# Live checks with real credentials are separate: tests/pi/smoke.zsh [--claude].

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
  for f in $src/dot_config/fish/config.fish $src/dot_config/fish/functions/{pi,__omp_profile,__memini_namespace_prefix}.fish; do
    fish --no-execute $f || return 1
  done
  for f in $src/dot_pi/shared/routing.json $src/dot_pi/private_agent/models.json $src/dot_pi/**/settings.json(.) $src/dot_omp/private_agent/mcp.json; do
    jq empty $f || return 1
  done
  for t in $src/dot_pi/**/modify_*.tmpl $src/.chezmoiscripts/run_onchange_after_configure-pi.sh.tmpl; do
    (cd $src && chezmoi execute-template < $t) > $out && zsh -n $out || { rm -f $out; return 1 }
  done
  # A first-time apply renders valid JSON with the managed keys.
  for t in $src/dot_pi/**/modify_*.tmpl; do
    (cd $src && chezmoi execute-template < $t) > $out && zsh $out < /dev/null | jq -e 'type == "object"' >/dev/null || { rm -f $out; return 1 }
  done
  rm -f $out
  print "ok"
}

retry_js() {
  local root
  for root in "$(brew --prefix pi-coding-agent 2>/dev/null)/libexec/lib/node_modules" "$(npm root -g 2>/dev/null)"; do
    [[ -f $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js ]] &&
      { print -r -- $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js; return }
  done
}

policy() { PI_AI_RETRY_JS=$(retry_js) node --test $here/policy.test.ts $here/permissions.test.ts $here/usage.test.ts $here/commit-trailers.test.ts }

integration() {
  if ! whence -pa pi | grep -qv "$HOME/.local/bin/pi"; then print "skipped: pi not installed"; return 0; fi
  if [[ ! -d $HOME/.pi/agent/npm || ! -d $HOME/.pi/profiles/work/agent/npm ]]; then print "skipped: profile packages not installed (chezmoi apply)"; return 0; fi
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
step policy policy
step launcher zsh $here/launcher.test.zsh
step integration integration
(( typecheck )) && step typecheck typecheck_ext
exit $rc
