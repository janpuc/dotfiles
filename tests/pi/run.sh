#!/usr/bin/env zsh
#
# Offline Pi checks. All runtime requests are loopback-only with synthetic keys.
# --typecheck reuses installed dev dependencies or installs from npm's offline cache.
# Stages: syntax/templates, settings merge, managed sets, unit/config tests,
# launcher, real-Pi integration (when installed), strict extension typecheck.
# No apply, package auto-install, or deployed-file changes.
#

emulate -L zsh
setopt no_unset pipe_fail null_glob

here=${0:A:h}
repo=${here:h:h}
src=$repo/home
rc=0
typecheck=0; [[ ${1-} == --typecheck ]] && typecheck=1
step() { print "\n== $1"; shift; "$@" || { rc=1; print "!! failed" } }

# Preload a loopback-only socket/DNS guard in every Node subprocess, and wrap the
# launcher's curl. Clean-env test children explicitly carry these guard variables.
# Proxies are defence in depth; they do not replace the fail-on-attempt audit.
PI_TEST_GUARD_DIR=$(mktemp -d)
export PI_TEST_GUARD_DIR PI_TEST_NETWORK_LOG=$PI_TEST_GUARD_DIR/network.log
trap 'rm -rf $PI_TEST_GUARD_DIR' EXIT
: > $PI_TEST_NETWORK_LOG
cat > $PI_TEST_GUARD_DIR/offline.cjs <<'JS'
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const local = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
function deny(target) {
  fs.appendFileSync(process.env.PI_TEST_NETWORK_LOG, `node: ${target}\n`);
  throw new Error(`Offline test blocked network target: ${target}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (!options.path && !local(options.host || 'localhost')) deny(options.host);
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!local(host)) deny(host);
  return lookup.call(this, host, ...args);
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...args) {
  if (!local(host)) deny(host);
  return promiseLookup.call(this, host, ...args);
};
JS
cat > $PI_TEST_GUARD_DIR/curl <<'PY'
#!/usr/bin/env python3
import os, sys
from urllib.parse import urlsplit
urls = [arg for arg in sys.argv[1:] if arg.startswith(('http://', 'https://'))]
if not urls or any(urlsplit(url).hostname not in ('127.0.0.1', 'localhost', '::1') for url in urls):
    with open(os.environ['PI_TEST_NETWORK_LOG'], 'a') as log:
        log.write('curl: non-loopback URL blocked\n')
    sys.exit(97)
# -q disables ~/.curlrc; --noproxy limits direct access to these loopback URLs.
os.execv('/usr/bin/curl', ['curl', '-q', '--noproxy', '127.0.0.1,localhost,::1', *sys.argv[1:]])
PY
chmod +x $PI_TEST_GUARD_DIR/curl
export NODE_OPTIONS="--require=$PI_TEST_GUARD_DIR/offline.cjs"
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost,::1
export http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY all_proxy=$ALL_PROXY no_proxy=$NO_PROXY
export PATH=$PI_TEST_GUARD_DIR:$PATH

offline_guard() {
  # The probes must fail before connecting, including fetch's DNS/socket path.
  node -e 'require("node:net").connect(443, "example.invalid")' >/dev/null 2>&1 && return 1
  node -e 'fetch("https://example.invalid").then(() => process.exit(0), () => process.exit(1))' >/dev/null 2>&1 && return 1
  curl -fsS https://example.invalid >/dev/null 2>&1 && return 1
  [[ $(wc -l < $PI_TEST_NETWORK_LOG) -ge 3 ]] || return 1
  : > $PI_TEST_NETWORK_LOG
  print 'ok: socket, fetch and curl external probes blocked before connection'
}
offline_audit() {
  if [[ -s $PI_TEST_NETWORK_LOG ]]; then
    print 'Unexpected external network attempts (blocked):'; cat $PI_TEST_NETWORK_LOG; return 1
  fi
  print 'ok: zero external network attempts; runtime endpoints were loopback-only'
}

syntax() {
  local f t out=$(mktemp)
  zsh -n $src/dot_local/bin/executable_pi || return 1
  for f in $src/dot_config/fish/functions/{pi,__memini_namespace_prefix}.fish; do
    fish --no-execute $f || return 1
  done
  # config.fish renders for the laptop and for the Linux server.
  for os in darwin linux; do
    (cd $src && chezmoi execute-template --override-data "{\"chezmoi\":{\"os\":\"$os\"}}" < dot_config/fish/config.fish.tmpl) > $out && fish --no-execute $out || { rm -f $out; return 1 }
    if [[ $os == linux ]] && grep -Eq '__memini_namespace_prefix|credentials.fish|DISABLE_AUTOUPDATER|MEMINI_|LITELLM_' $out; then
      print 'Linux shell still depends on retired AI tools/state'; rm -f $out; return 1
    fi
    (cd $src && chezmoi execute-template --override-data "{\"chezmoi\":{\"os\":\"$os\"}}" < dot_config/fish/functions/ai-sync.fish.tmpl) > $out && fish --no-execute $out || { rm -f $out; return 1 }
    if [[ $os == linux ]]; then
      grep -q 'gh auth login --with-token' $out && ! grep -Eq 'CRED_FILE|MEMINI_API_KEY|LITELLM_API_KEY|PI_.*API_KEY' $out || { rm -f $out; return 1 }
    fi
  done
  for f in $src/dot_pi/private_agent/models.json $src/dot_pi/**/settings.json(.); do
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

merge() { node --test $here/settings-merge.test.ts }

# Render the actual Linux ignore rules into a temporary source state. Querying the managed
# set proves a future aether apply manages shell basics only, with no AI runtimes.
platforms() {
  local tmp=$(mktemp -d) os managed
  mkdir -p $tmp/source $tmp/target
  cp -R $src/. $tmp/source/
  print -n '' > $tmp/config.toml
  for os in darwin linux; do
    (cd $src && chezmoi execute-template --override-data "{\"chezmoi\":{\"os\":\"$os\"}}" < .chezmoiignore) > $tmp/source/.chezmoiignore
    managed=$(chezmoi --config $tmp/config.toml --source $tmp/source --destination $tmp/target managed) || { rm -rf $tmp; return 1 }
    if [[ $os == darwin ]]; then
      local target
      for target in .local/bin/pi .local/bin/pi-profile .pi/shared/extensions/memory/index.ts .pi/agent/settings.json .pi/agent/subagent-manager/settings.json .pi/shared/extensions/profile/title.ts .pi/agent/subagent-manager/agents/{architect,coder,researcher,reviewer,tasker,writer}.yml; do
        print -r -- $managed | grep -Fxq $target || { print "Missing Mac target: $target"; rm -rf $tmp; return 1 }
      done
      if print -r -- $managed | grep -Eq '^\.t3(/|$)|^\.pi/shared/personal-policy\.json$|^\.config/(mise|systemd)(/|$)|linux-'; then
        print 'Mac would receive a server-only or retired source'; rm -rf $tmp; return 1
      fi
    else
      if print -r -- $managed | grep -Eq '^\.pi(/|$)|^\.local/bin/pi[^/]*$|^\.config/fish/functions/pi\.fish$'; then
        print 'Linux must manage no Pi files'; rm -rf $tmp; return 1
      fi
      local expected='.chezmoiscripts/00-linux-apt.sh
.chezmoiscripts/05-linux-system.sh
.chezmoiscripts/06-linux-terminfo.sh
.chezmoiscripts/10-linux-mise.sh
.config
.config/atuin
.config/atuin/config.toml
.config/atuin/themes
.config/atuin/themes/catppuccin-mocha-blue.toml
.config/bat
.config/bat/config
.config/bat/themes
.config/bat/themes/Catppuccin Mocha.tmTheme
.config/eza
.config/eza/theme.yml
.config/fish
.config/fish/config.fish
.config/fish/functions
.config/fish/functions/ai-sync.fish
.config/fish/themes
.config/fish/themes/catppuccin-mocha.theme
.config/git
.config/git/config
.config/git/ignore
.config/mise
.config/mise/config.toml
.config/starship.toml
.editorconfig'
      [[ $(print -r -- $managed | LC_ALL=C sort) == $expected ]] || {
        print 'Unexpected Linux managed set:'; print -r -- $managed; rm -rf $tmp; return 1
      }
    fi
  done
  rm -rf $tmp
  print 'ok: Mac Pi resources managed; Linux shell/GitHub tools only, no AI runtimes'
}

retry_js() {
  local root
  for root in "$(brew --prefix pi-coding-agent 2>/dev/null)/libexec/lib/node_modules" "$(npm root -g 2>/dev/null)"; do
    [[ -f $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js ]] &&
      { print -r -- $root/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js; return }
  done
}

policy() { PI_AI_RETRY_JS=$(retry_js) node --test $here/memory-scope.test.ts $here/usage.test.ts $here/commit-trailers.test.ts $here/memory.test.ts $here/title.test.ts $here/manager-config.test.ts }

integration() {
  if ! whence -pa pi | grep -qv "$HOME/.local/bin/pi"; then print "skipped: pi not installed"; return 0; fi
  if [[ ! -f $HOME/.pi/agent/npm/node_modules/@eleboucher/pi-memini/dist/index.js ]]; then
    print "skipped: pi-memini not installed (no installation attempted)"; return 0
  fi
  zsh $here/integration.test.zsh
}

typecheck_ext() {
  local pi_pkg=${$(retry_js)%/node_modules/@earendil-works/pi-ai/dist/utils/retry.js}
  [[ -n $pi_pkg ]] || { print "skipped: installed Pi not found"; return 0 }
  local tmp=$(mktemp -d) deps=${PI_TEST_TYPECHECK_DEPS:-${TMPDIR:-/tmp}/pi-test-typecheck-deps}
  # Keep this disposable dependency cache between runs; never install into the repo/HOME.
  if [[ -f $pi_pkg/node_modules/typescript/bin/tsc && -d $pi_pkg/node_modules/@types/node ]]; then
    deps=$pi_pkg
    print "using installed Pi dev dependencies (no install)"
  elif [[ -f $deps/node_modules/typescript/bin/tsc && -d $deps/node_modules/@types/node ]]; then
    print "using cached typecheck dev dependencies (no install)"
  else
    print "installing typescript@5 and @types/node@24 from npm's OFFLINE cache into $deps"
    mkdir -p $deps
    # npm may write cache metadata/logs even offline. Copy its cache into the
    # sandbox so the dependency install cannot modify deployed HOME files.
    local cache=${npm_config_cache:-$HOME/.npm}
    mkdir -p $tmp/npm-cache
    : > $tmp/npm-user.conf; : > $tmp/npm-global.conf
    [[ ! -d $cache/_cacache ]] || cp -R $cache/_cacache $tmp/npm-cache/ || { rm -rf $tmp; return 1 }
    (cd $deps && HOME=$tmp npm --userconfig=$tmp/npm-user.conf --globalconfig=$tmp/npm-global.conf --cache=$tmp/npm-cache --logs-dir=$tmp/npm-logs install --offline --ignore-scripts --no-audit --no-fund --no-package-lock typescript@5 @types/node@24) || {
      print "Offline dev dependencies unavailable; set PI_TEST_TYPECHECK_DEPS to a prepared directory."
      rm -rf $tmp; return 1
    }
  fi
  jq -n --arg pi $pi_pkg --arg ext $src/dot_pi/shared/extensions/profile --arg types $deps/node_modules/@types '{
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
      skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"], typeRoots: [$types], baseUrl: ".",
      paths: { "@earendil-works/pi-coding-agent": ["\($pi)/dist/index.d.ts"],
               "@earendil-works/*": ["\($pi)/node_modules/@earendil-works/*"], typebox: ["\($pi)/node_modules/typebox"] } },
    files: $files }' --argjson files "$(print -rl -- $src/dot_pi/shared/extensions/*/*.ts(.) | jq -R . | jq -s .)" > $tmp/tsconfig.json
  node $deps/node_modules/typescript/bin/tsc -p $tmp/tsconfig.json && print "ok"
  local st=$?; rm -rf $tmp; return $st
}

# Fail closed: do not start runtime tests if the guard probes fail.
print '\n== offline-guard'
offline_guard || { print 'Offline guard failed; no tests run'; exit 1 }
step syntax syntax
step merge merge
step platforms platforms
step policy policy
step launcher zsh $here/launcher.test.zsh
step integration integration
(( typecheck )) && step typecheck typecheck_ext
step offline-audit offline_audit
exit $rc
