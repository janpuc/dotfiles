const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stage = path.join(__dirname, 'aether-backup-stage');
const backup = fs.readFileSync(path.join(__dirname, 'aether-backup'), 'utf8');
const publish = backup.split("<<'PY'\n")[1].split('\nPY\n')[0];
const metrics = backup.split("<<'PY'\n")[2].split('\nPY\n')[0];

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-backup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Keep the source connection open, with committed data still in the WAL, throughout
// the actual helper subprocess. Nothing reads or writes the real Pocket database.
test('aether-backup-stage: live WAL snapshot, private files, no secrets, links or locks', t => {
    const dir = scratch(t);
    const result = spawnSync('python3', ['-', stage, dir], { encoding: 'utf8', input: `
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
helper, scratch = sys.argv[1:]
root = Path(scratch) / 'source'
pocket = root / 'home/pocket/.pi-pocket'
broker = root / 'var/lib/pr-broker'
for directory in (pocket, broker, root / 'home/pocket/archive', root / 'home/pocket/.local/state/upstream-sync'):
    directory.mkdir(parents=True)
connection = sqlite3.connect(pocket / 'pocket.sqlite')
assert connection.execute('PRAGMA journal_mode=WAL').fetchone() == ('wal',)
connection.execute('CREATE TABLE messages (text TEXT)')
connection.execute("INSERT INTO messages VALUES ('committed in WAL')")
connection.commit()
connection.execute("INSERT INTO messages VALUES ('uncommitted')")
assert (pocket / 'pocket.sqlite-wal').stat().st_size > 0
for name in ('config.json', 'push.json', 'launcher.json', 'provider-limits.json'):
    (pocket / name).write_text('{}')
for name in ('uploads', 'extensions', 'background', 'themes'):
    (pocket / name).mkdir()
    (pocket / name / 'data').write_text('data')
for name in ('secrets.env', 'github-app.pem', 'other.pem', 'private.key', 'harness.lock', 'harness.lock.identity'):
    (pocket / name).write_text('DO NOT BACK UP')
(pocket / 'extensions/link').symlink_to(pocket / 'secrets.env')
(pocket / 'linked-dir').symlink_to(broker, target_is_directory=True)
for name in ('processed-requests.json', 'merge-attempts.json', 'hostile-report.json', 'result-cursor.json', 'merge.lock'):
    (broker / name).write_text('{}')
(broker / 'gh').mkdir()
(broker / 'gh/hosts.yml').write_text('secret token')
(root / 'home/pocket/archive/upgrade.tar.gz').write_bytes(b'archive fixture')
(root / 'home/pocket/.local/state/upstream-sync/last-sha').write_text('abc')
output = Path(scratch) / 'staged'
subprocess.run([sys.executable, helper, str(root), str(output)], check=True)
with sqlite3.connect(output / 'pi-pocket/pocket.sqlite') as snapshot:
    assert snapshot.execute('SELECT * FROM messages').fetchall() == [('committed in WAL',)]
    assert snapshot.execute('PRAGMA integrity_check').fetchone() == ('ok',)
assert set(p.name for p in (output / 'pr-broker').iterdir()) == {'processed-requests.json', 'merge-attempts.json', 'hostile-report.json', 'result-cursor.json'}
assert (output / 'upstream-sync/last-sha').read_text() == 'abc'
assert (output / 'archive/upgrade.tar.gz').read_bytes() == b'archive fixture'
for item in output.rglob('*'):
    assert not item.is_symlink(), item
    assert item.stat().st_mode & 0o777 == (0o700 if item.is_dir() else 0o600), item
    if item.is_file():
        assert b'DO NOT BACK UP' not in item.read_bytes(), item
assert not (output / 'pi-pocket/pocket.sqlite-wal').exists()
assert not (output / 'pi-pocket/pocket.sqlite-shm').exists(), [(p.name, p.stat().st_size) for p in (output / 'pi-pocket').iterdir()]
assert not (output / 'pi-pocket/harness.lock').exists()
assert not (output / 'pi-pocket/extensions/link').exists()
assert not (output / 'pi-pocket/linked-dir').exists()
# A reused/nonempty destination must fail instead of mixing snapshots.
assert subprocess.run([sys.executable, helper, str(root), str(output)], capture_output=True).returncode != 0
connection.rollback()
connection.close()
print('Live WAL snapshot contains committed data only; integrity_check=ok; exclusions and modes verified')
` });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /integrity_check=ok/);
});

test('aether-backup: publish replaces same day, prunes only dated trees older than 14 days', t => {
    const dir = scratch(t);
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'nas/aether/state');
    fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'state.json'), 'new state', { mode: 0o600 });
    for (const name of ['2026-10-30', '2026-10-17', '2026-10-16', '2026-99-99', 'unrelated']) {
        fs.mkdirSync(path.join(destination, name), { recursive: true });
        fs.writeFileSync(path.join(destination, name, 'old'), 'old state');
    }
    const result = spawnSync('python3', ['-', source, destination, '2026-10-30'], { input: publish, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(destination, '2026-10-30/state.json'), 'utf8'), 'new state');
    assert.deepEqual(fs.readdirSync(destination).sort(), ['2026-10-17', '2026-10-30', '2026-99-99', 'unrelated']);
    assert.equal(fs.statSync(path.join(destination, '2026-10-30')).mode & 0o777, 0o700);
});

test('aether-backup: metrics require an existing, enabled node_exporter textfile collector', t => {
    const dir = scratch(t);
    const proc = path.join(dir, 'proc');
    const collector = path.join(dir, 'collector');
    fs.mkdirSync(path.join(proc, '123'), { recursive: true });
    fs.mkdirSync(collector);
    const file = path.join(collector, 'aether-backup.prom');
    const code = 'import sys\n' + metrics.replace("Path('/proc')", 'Path(sys.argv[1])');
    function run(args) {
        fs.writeFileSync(path.join(proc, '123/cmdline'), args.join('\0') + '\0');
        const result = spawnSync('python3', ['-', proc], { input: code, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    run(['/usr/bin/unrelated', `--collector.textfile.directory=${collector}`]);
    assert.equal(fs.existsSync(file), false);
    run(['/usr/bin/node_exporter', '--collector.disable-defaults', `--collector.textfile.directory=${collector}`]);
    assert.equal(fs.existsSync(file), false);
    run(['/usr/bin/node_exporter', '--no-collector.textfile', `--collector.textfile.directory=${collector}`]);
    assert.equal(fs.existsSync(file), false);
    run(['/usr/bin/node_exporter', `--collector.textfile.directory=${path.join(dir, 'missing')}`]);
    assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
    run(['/usr/bin/node_exporter', '--collector.textfile.directory', collector]);
    assert.match(fs.readFileSync(file, 'utf8'), /aether_backup_last_success_timestamp_seconds \d+\n/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(collector), ['aether-backup.prom']);
});

test('aether-backup: failed rsync preserves the previous success and does not prune', t => {
    const dir = scratch(t);
    const destination = path.join(dir, 'nas');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'rsync'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    for (const name of ['2026-10-30', '2026-10-01']) {
        fs.mkdirSync(path.join(destination, name), { recursive: true });
        fs.writeFileSync(path.join(destination, name, 'previous'), 'keep');
    }
    const result = spawnSync('python3', ['-', dir, destination, '2026-10-30'], {
        input: publish, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(destination, '2026-10-30/previous'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(destination).sort(), ['2026-10-01', '2026-10-30']);
});
