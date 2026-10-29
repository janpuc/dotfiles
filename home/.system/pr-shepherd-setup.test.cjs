const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = name => readFileSync(join(__dirname, name), 'utf8');
const setup = source('../.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl');
test('pr-shepherd setup isolates broker account, spool, root code and secrets, restarts pocket for new group', () => {
    for (const text of ['--system --user-group --no-create-home --home-dir /var/lib/pr-broker --shell /usr/sbin/nologin',
        '--gid pr-broker --groups pr-requesters pr-broker', '--append --groups pr-requesters pocket',
        'as_pocket chmod 700 "$home"', '-o root -g root -m 755 /etc/pr-broker',
        '-o pr-broker -g pr-requesters -m 3770 /var/spool/pr-broker/requests',
        '-o pr-broker -g pr-requesters -m 2750 /var/spool/pr-broker/results',
        '-o pr-broker -g pr-broker -m 700 /var/lib/pr-broker',
        'sudo install -o root -g root -m 755', 'sudo systemctl enable --now pr-broker.timer pr-lane-merge.timer']) assert.ok(setup.includes(text), text);
    assert.ok(setup.indexOf('sudo systemctl start pi-pocket.service') > setup.indexOf('--append --groups pr-requesters pocket'));
    assert.ok(!/^.*(?:touch|install|tee|printf).*\/(?:requests|lane-a)\.enabled/m.test(setup));
    assert.ok(setup.indexOf('sudo systemctl stop "$unit"') < setup.indexOf('sudo /bin/sh "$src/pr-broker-runtime.sh"'));
});
test('pi-pocket setup installs upstream-diff root-owned, its mapping and skill as pocket, and the ask-jan drop-in', () => {
    for (const text of [
        'sudo install -o root -g root -m 755 "$src/upstream-diff" /usr/local/sbin/upstream-diff',
        'pocket_install 644 "$src/upstream-sync.yaml" "$home/.pi/agent/skills/upstream-sync/upstream-sync.yaml"',
        'for skill in homelab-cluster home-assistant github pr-shepherd upstream-sync; do',
        'for extension in memini.ts approvals.ts web.ts ask-jan.ts; do',
        '("memini.ts", "approvals.ts", "web.ts", "ask-jan.ts", "triggers.ts", "schedules.ts")'])
        assert.ok(setup.includes(text), text);
    for (const name of ['upstream-diff', 'upstream-sync.yaml', 'pi-pocket-skills/upstream-sync/SKILL.md',
        'pi-pocket-extensions/ask-jan.ts'])
        assert.ok(setup.includes(`include ".system/${name}" | sha256sum`), name);
    // The tool is root-owned and writes nothing under pocket's home itself.
    assert.ok(!setup.split('\n').some(line => /sudo (?:install|tee|cat)[^\n]*\$home/.test(line)));
    assert.ok(!setup.includes('sudo install -o root -g root -m 755 "$src/upstream-diff" /home/pocket'));
});
test('pi-pocket setup clones the Home Assistant config repo and skips it while it does not exist', () => {
    for (const text of ['optional_repos="home-assistant"', 'for repo in $repos $optional_repos; do',
        '*" $repo "*) echo "Skipping the $repo clone', '*) echo "Cannot clone janpuc/$repo." >&2; exit 1 ;;'])
        assert.ok(setup.includes(text), text);
});
test('pr-shepherd setup hashes every broker source and installs pinned root runtime independent of mise', () => {
    for (const name of ['pr-broker', 'pr-broker-runtime.sh', 'pr-merge-request', 'pr-broker.service', 'pr-broker.timer', 'pr-lane-merge', 'pr-lane-merge.service', 'pr-lane-merge.timer', 'pr-broker-lock'])
        assert.ok(setup.includes(`include ".system/${name}" | sha256sum`), name);
    const runtime = source('pr-broker-runtime.sh'), mise = source('pi-pocket-mise.toml');
    for (const tool of ['node', 'gh']) {
        const version = mise.match(new RegExp(`${tool} = "([^"]+)"`))[1];
        assert.ok(runtime.includes(`${tool}_version=${version}`));
    }
    assert.ok(runtime.includes('sha256sum --check node-checksum')); assert.ok(runtime.includes('sha256sum --check gh-checksum'));
    assert.ok(!runtime.includes('/home/pocket'));
});
test('pr-shepherd units share lock, empty capabilities, protect homes and explicit writable paths', () => {
    for (const name of ['pr-broker', 'pr-lane-merge']) {
        const unit = source(`${name}.service`);
        for (const text of ['User=pr-broker', 'ProtectHome=yes', 'ProtectSystem=strict', 'NoNewPrivileges=yes',
            'PrivateTmp=yes', 'CapabilityBoundingSet=\n', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
            'ExecStart=/usr/local/sbin/pr-broker-lock ',
            'ReadWritePaths=/var/lib/pr-broker /var/spool/pr-broker/requests /var/spool/pr-broker/results'])
            assert.ok(unit.includes(text), `${name}: ${text}`);
        assert.ok(!unit.includes('BindPaths=')); assert.ok(!unit.includes('/home/pocket'));
    }
    assert.match(source('pr-broker.service'), /ExecStart=\/usr\/local\/sbin\/pr-broker-lock requests/);
    assert.match(source('pr-lane-merge.service'), /ExecStart=\/usr\/local\/sbin\/pr-broker-lock lane-a/);
    // The lane A run waits for the lock, the request run never does.
    assert.match(source('pr-lane-merge.service'), /TimeoutStartSec=30min/);
    assert.match(source('pr-broker.timer'), /OnUnitInactiveSec=1min/);
    assert.match(source('pr-lane-merge.timer'), /OnCalendar=\*:0\/30/);
});
test('pr-shepherd lock wrapper: a held lock is logged, a failed run keeps its status', t => {
    const fs = require('node:fs'), cp = require('node:child_process'), os = require('node:os');
    const root = fs.mkdtempSync(join(os.tmpdir(), 'broker-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // The wrapper's decision, not flock itself: the exit code is the contract.
    const code = join(root, 'code'), fakeFlock = join(root, 'flock'), broker = join(root, 'broker');
    fs.writeFileSync(code, '0');
    fs.writeFileSync(fakeFlock, `#!/bin/sh
while [ $# -gt 0 ]; do
    case "$1" in
        --conflict-exit-code|--timeout) shift 2 ;;
        -*) shift ;;
        *) break ;;
    esac
done
shift
status=$(cat "${code}")
[ "$status" -eq 0 ] && exec "$@"
exit "$status"
`, { mode: 0o755 });
    fs.writeFileSync(broker, '#!/bin/sh\necho "broker ran"\n', { mode: 0o755 });
    const wrapper = source('pr-broker-lock')
        .replaceAll('/usr/bin/flock', fakeFlock)
        .replaceAll('/var/lib/pr-broker/merge.lock', join(root, 'merge.lock'))
        .replaceAll('/opt/pr-broker/bin/node', broker)
        .replaceAll('/usr/local/sbin/pr-broker', broker)
        .replaceAll('/usr/local/sbin/pr-lane-merge', broker);
    fs.writeFileSync(join(root, 'pr-broker-lock'), wrapper, { mode: 0o755 });
    const run = (...args) => cp.spawnSync(join(root, 'pr-broker-lock'), args, { encoding: 'utf8' });
    // A free lock runs the broker.
    let result = run('requests');
    assert.equal(result.status, 0); assert.ok(result.stdout.includes('broker ran'));
    // A held lock is a logged skip, never a silent success.
    fs.writeFileSync(code, '75');
    result = run('requests');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /skipped: lock held/);
    assert.ok(!result.stdout.includes('broker ran'));
    // Lane A gives up on the same conflict and says so.
    result = run('lane-a');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /gave up waiting 300s for the merge lock/);
    // A failed run keeps its exit status.
    fs.writeFileSync(code, '1');
    result = run('requests');
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('skipped: lock held'));
    // An unknown mode or a bad bound is refused.
    assert.equal(run('nonsense').status, 2);
    assert.equal(run('lane-a', 'x').status, 2);
    assert.equal(run('lane-a', '99999').status, 2);
});

test('installer pocket symlinks cannot append broker switches or change trusted directory ownership/mode', t => {
    const fs = require('node:fs'), cp = require('node:child_process'), os = require('node:os');
    const root = fs.mkdtempSync(join(os.tmpdir(), 'pocket-path-audit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'pocket'), protectedDir = join(root, 'trusted');
    fs.mkdirSync(home); fs.mkdirSync(protectedDir, { mode: 0o755 });
    const enabled = join(protectedDir, 'requests.enabled'); fs.writeFileSync(enabled, 'unchanged');
    fs.symlinkSync(enabled, join(home, '.profile')); fs.symlinkSync(protectedDir, join(home, '.kube'));
    // Model sudo's credential boundary without needing root/a pocket account. Root-mode
    // commands execute normally; pocket-mode commands cannot touch our root-owned model.
    fs.writeFileSync(join(root, 'sudo'), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');let a=process.argv.slice(2);
if(a[0]==='-u') { if(a[1]!=='pocket'||a[2]!=='-H') process.exit(91); a=a.slice(3);
 for(const p of a) { try { if(fs.realpathSync(p).startsWith(fs.realpathSync(process.env.PROTECTED))) process.exit(1); }catch{} }
}
else { a=a.filter((v,i)=>!['-o','-g'].includes(v)&&!['-o','-g'].includes(a[i-1])); }
const r=cp.spawnSync(a[0],a.slice(1),{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: root + ':' + process.env.PATH, PROTECTED: protectedDir };
    const functions = setup.match(/as_pocket\(\) \{[^\n]+/)[0];
    const append = setup.split('\n').find(line => line.includes('tee -a "$home/.profile"'));
    const mkdir = setup.split('\n').find(line => line.includes('install -d') && line.includes('"$home/.kube"'));
    for (const command of [append, mkdir]) {
        const run = cp.spawnSync('/bin/sh', ['-c', `${functions}\nhome="$1"\n${command}`, 'sh', home], { env });
        assert.notEqual(run.status, 0, 'pocket cannot write through protected symlink');
    }
    assert.equal(fs.readFileSync(enabled, 'utf8'), 'unchanged');
    assert.equal(fs.statSync(protectedDir).mode & 0o777, 0o755);
    const sync = source('../dot_config/fish/functions/ai-sync.fish.tmpl');
    assert.equal((sync.match(/sudo -u pocket -H sh -c 'umask 077; cat/g) || []).length, 3);
    assert.ok(!setup.split('\n').some(line => /sudo (?:install|tee|chmod).*\$home/.test(line)));
    assert.ok(!/sudo install[^\n]*\/home\/pocket/.test(sync));
    fs.mkdirSync(join(home, '.config')); fs.mkdirSync(join(home, '.config/pi-pocket'));
    fs.symlinkSync(enabled, join(home, '.config/pi-pocket/secrets.env'));
    const secret = join(root, 'secret'); fs.writeFileSync(secret, 'agent-only');
    const secretWrite = sync.split('\n').find(line => line.includes('sh /home/pocket/.config/pi-pocket/secrets.env'))
        .replace('/home/pocket', home).replace('<$tmp', `<"${secret}"`);
    assert.notEqual(cp.spawnSync('/bin/sh', ['-c', secretWrite], { env }).status, 0);
    assert.equal(fs.readFileSync(enabled, 'utf8'), 'unchanged');

    for (const text of ['os.O_NOFOLLOW', 'os.fchown(home', 'os.fchmod(home']) assert.ok(setup.includes(text));
});
test('pr-broker-runtime pinned archive mismatch aborts before extraction, with no checksum download', t => {
    const fs = require('node:fs'), cp = require('node:child_process'), os = require('node:os');
    const root = fs.mkdtempSync(join(os.tmpdir(), 'broker-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Sandbox absolute destinations and root/architecture probes; retain real sha256sum.
    let runtime = source('pr-broker-runtime.sh').replace('PATH=/usr/bin:/bin', `PATH=${root}:${process.env.PATH}`)
        .replaceAll('/opt/pr-broker', join(root, 'runtime')).replaceAll('-o root -g root', '');
    fs.writeFileSync(join(root, 'runtime.sh'), runtime);
    for (const [name, body] of Object.entries({ id: 'echo 0', uname: 'echo aarch64',
        curl: 'echo "$*" >> "$CALLS"; for arg do archive=$arg; done; basename=${archive##*/}; printf corrupted > "$basename"',
        tar: 'echo extracted >> "$CALLS"; exit 99' }))
        fs.writeFileSync(join(root, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    const result = cp.spawnSync('/bin/sh', [join(root, 'runtime.sh')], { env: { ...process.env, CALLS: join(root, 'calls') }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /FAILED/);
    const calls = fs.readFileSync(join(root, 'calls'), 'utf8');
    assert.ok(!/SHASUMS|checksums|extracted/.test(calls));
    assert.ok(runtime.includes('95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2'));
    assert.ok(runtime.includes('7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484'));
    const nodeBin = join(root, 'runtime/releases/node-24.22.2/bin');
    fs.mkdirSync(nodeBin, { recursive: true }); fs.writeFileSync(join(nodeBin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    const ghMismatch = cp.spawnSync('/bin/sh', [join(root, 'runtime.sh')], { env: { ...process.env, CALLS: join(root, 'calls') }, encoding: 'utf8' });
    assert.notEqual(ghMismatch.status, 0); assert.match(ghMismatch.stdout + ghMismatch.stderr, /FAILED/);
    const allCalls = fs.readFileSync(join(root, 'calls'), 'utf8');
    assert.ok(allCalls.includes('gh_2.102.0_linux_arm64.tar.gz')); assert.ok(!allCalls.includes('extracted'));

});
