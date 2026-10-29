const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise only the cleanup/install seam with a fake sudo; never run the setup itself.
const template = readFileSync(join(__dirname, '../.chezmoiscripts/run_onchange_after_20-linux-pi-pocket.sh.tmpl'), 'utf8');
const seam = template.slice(template.indexOf('# Step 1:'), template.indexOf('sudo install -m 644 "$src/pi-pocket.service"'));
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'pr-shepherd-setup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'sudo'), `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
if (args[0] === 'systemctl' && args[1] === 'cat' && process.env.ABSENT) process.exit(1);
if (args[0] === 'systemctl' && args[1] === 'disable' && process.env.FAIL_DISABLE) process.exit(1);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: log };
    return { env, run: () => spawnSync('sh', ['-eu', '-c', `src=/source\n${seam}`], { env, encoding: 'utf8' }),
        calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}
test('pr-shepherd setup: retires a stale timer before installing only Step 1 tools', t => {
    const f = fixture(t);
    assert.equal(f.run().status, 0);
    const calls = f.calls();
    const disable = calls.indexOf('systemctl disable --now pr-lane-merge.timer');
    const remove = calls.findIndex(c => c.startsWith('rm -f '));
    assert.ok(disable >= 0 && disable < remove);
    assert.ok(calls.includes('systemctl stop pr-lane-merge.service'));
    for (const path of ['/etc/systemd/system/timers.target.wants/pr-lane-merge.timer',
        '/etc/systemd/system/pr-lane-merge.timer', '/etc/systemd/system/pr-lane-merge.service',
        '/usr/local/sbin/pr-lane-merge']) assert.ok(calls[remove].includes(path));
    assert.deepEqual(calls.filter(c => c.startsWith('install ')), [
        'install -m 755 /source/agent-push /usr/local/sbin/agent-push',
        'install -m 755 /source/pr-lane /usr/local/sbin/pr-lane',
    ]);
    assert.ok(!calls.some(c => c.startsWith('systemctl enable')));
});
test('pr-shepherd setup: first install tolerates absent retired units', t => {
    const f = fixture(t); f.env.ABSENT = '1';
    assert.equal(f.run().status, 0);
    assert.ok(!f.calls().some(c => c.startsWith('systemctl disable') || c.startsWith('systemctl stop')));
});
test('pr-shepherd setup: cannot silently continue if disabling an installed timer fails', t => {
    const f = fixture(t); f.env.FAIL_DISABLE = '1';
    assert.notEqual(f.run().status, 0);
    assert.ok(!f.calls().some(c => c.startsWith('install ')));
});
