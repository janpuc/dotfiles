const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID, generateKeyPairSync, verify } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runBroker, validateRequest, readRequest, enabled, mintToken } = require('./pr-broker');
const { submit } = require('./pr-merge-request');
const head = 'a'.repeat(40);
const { fixture } = require('./pr-broker-test-fixture.cjs');

test('pr-merge-request validates arguments, uses random names, writes public bounded requests and prints result path', t => {
    const f = fixture(t);
    for (const args of [[], ['0', head], ['01', head], ['-1', head], ['1.2', head], ['1;id', head], ['9007199254740992', head], ['42', 'a'.repeat(39)], ['42', 'A'.repeat(40)], ['42', head, 'extra']])
        assert.throws(() => submit(args, f.o.spool));
    for (const request of [{ pr: '42', head }, { pr: 42, head, extra: true }, [], null]) assert.throws(() => validateRequest(request));
    const a = f.request(), b = f.request(); assert.notEqual(a, b);
    const input = join(f.o.spool, 'requests', a.split('/').at(-1));
    assert.deepEqual(readRequest(input), { pr: 42, head });
    assert.equal(fs.statSync(input).mode & 0o777, 0o644);
});
test('pr-broker defaults to dry-run without root switches; result readable, request deleted, clean child environment', async t => {
    const f = fixture(t), file = f.request();
    await f.run();
    assert.equal(f.result(file).status, 'dry-run'); assert.deepEqual(f.pending(), []);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(f.calls().map(c => c.tool), ['lane']);
    assert.deepEqual(f.calls()[0].args, ['42', '--json', '--gh', f.o.gh]);
    assert.equal(f.calls()[0].PATH, '/usr/bin:/bin'); assert.equal(f.calls()[0].NODE_OPTIONS, undefined);
    assert.equal(fs.existsSync(join(f.o.state, 'merge-attempts.json')), false);
});
test('pr-broker refuses lane C/wait, wrong PR or head with classifier reasons', async t => {
    const f = fixture(t); f.enable();
    for (const fresh of [{ lane: 'C' }, { lane: 'wait' }, { head: 'b'.repeat(40) }, { pr: 99 }]) {
        f.data.fresh = fresh; f.save(); const file = f.request(); await f.run();
        assert.equal(f.result(file).status, 'refused'); assert.ok(f.result(file).reasons.includes('evidence'));
    }
    assert.equal(f.calls().filter(c => c.tool === 'gh').length, 0);
});
test('pr-broker merges lanes A/B with exact pinned gh arguments and a child-only token', async t => {
    const f = fixture(t); f.enable();
    for (const lane of ['A', 'B']) {
        f.data.fresh = { lane }; f.save(); const file = f.request(); await f.run();
        assert.equal(f.result(file).status, 'merged');
    }
    for (const call of f.calls().filter(c => c.tool === 'gh')) {
        assert.deepEqual(call.args, ['api', '-X', 'PUT', 'repos/janpuc/home-ops/pulls/42/merge', '-f', 'merge_method=squash', '-f', `sha=${head}`]);
        assert.equal(call.tokenPresent, true);
    }
    for (const name of fs.readdirSync(f.o.state)) assert.ok(!fs.readFileSync(join(f.o.state, name), 'utf8').includes('test-token'));
});
test('pr-broker shared rolling-hour quota survives separate runs; uncertain failures count and bad state fails closed', async t => {
    const f = fixture(t); f.enable(); f.enable('lane-a');
    fs.writeFileSync(join(f.o.state, 'merge-attempts.json'), JSON.stringify(Array(9).fill(Date.now())));
    assert.equal(await f.run('lane-a'), true);
    const file = f.request(); await f.run(); assert.equal(f.result(file).status, 'refused');
    assert.match(f.result(file).reasons[0], /rate limit/);
    fs.writeFileSync(join(f.o.state, 'merge-attempts.json'), JSON.stringify(Array(10).fill(Date.now() - 3600001)));
    f.data.fail = true; f.save(); const failed = f.request(); await f.run(); assert.equal(f.result(failed).status, 'error');
    assert.equal(JSON.parse(fs.readFileSync(join(f.o.state, 'merge-attempts.json'))).length, 1);
    fs.writeFileSync(join(f.o.state, 'merge-attempts.json'), 'broken');
    const bad = f.request(); await f.run(); assert.equal(f.result(bad).status, 'error');
    assert.equal(f.calls().filter(c => c.tool === 'gh').length, 2);
});
test('pr-broker malformed JSON/values, oversized file, bad name, symlink, FIFO and directory refused and deleted without following', async t => {
    const f = fixture(t), dir = join(f.o.spool, 'requests');
    const name = () => join(dir, `request-${randomUUID()}.json`);
    for (const content of ['{', '{}', JSON.stringify({ pr: 42, head: 'x' }), ' '.repeat(513)]) fs.writeFileSync(name(), content);
    fs.writeFileSync(join(dir, 'untrusted-name'), JSON.stringify({ pr: 42, head }));
    const target = join(f.root, 'target'); fs.writeFileSync(target, 'unchanged'); fs.symlinkSync(target, name());
    execFileSync('/usr/bin/mkfifo', [name()]); fs.mkdirSync(name());
    await f.run(); assert.deepEqual(f.pending(), []); assert.equal(f.results().length, 8);
    assert.ok(f.results().every(r => r.status === 'refused')); assert.deepEqual(f.calls(), []);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});
test('pr-broker refuses hardlinks and races from regular file to symlink', t => {
    const f = fixture(t), result = f.request(), input = join(f.o.spool, 'requests', result.split('/').at(-1));
    const link = join(f.root, 'hardlink'); fs.linkSync(input, link); assert.throws(() => readRequest(input)); fs.unlinkSync(link);
    const original = fs.openSync;
    t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
        if (file === input) { fs.unlinkSync(input); fs.symlinkSync('/dev/null', input); }
        return original(file, flags, ...rest);
    });
    assert.throws(() => readRequest(input));
});
test('pr-broker bounded flood: processes at most 100 correctly named regular requests per run', async t => {
    const f = fixture(t);
    for (let i = 0; i < 105; i++) fs.writeFileSync(join(f.o.spool, 'requests', `request-${randomUUID()}.json`), '{}');
    await f.run(); assert.equal(f.results().length, 100); assert.equal(f.pending().length, 5);
    await f.run(); assert.equal(f.results().length, 105); assert.equal(f.pending().length, 0);
});
test('pr-broker leftover directories do not consume request budget; valid work first and one bounded hostile summary per run', async t => {
    const f = fixture(t), log = [];
    t.mock.method(console, 'error', line => log.push(line));
    for (let i = 0; i < 110; i++) {
        const dir = join(f.o.spool, 'requests', `bad-directory-${i}`);
        fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'child'), 'never traverse');
    }
    fs.writeFileSync(join(f.o.spool, 'requests', 'bad-file'), '{}');
    const result = f.request();
    const original = fs.rmdirSync;
    t.mock.method(fs, 'rmdirSync', (...args) => {
        assert.equal(f.result(result).status, 'dry-run', 'process real requests before hostile cleanup');
        return original(...args);
    });
    await f.run(); assert.equal(f.result(result).status, 'dry-run');
    // At most 20 hostile entries are handled per run; the rest wait for later runs.
    assert.equal(log.length, 1);
    assert.match(log[0], /refused 20 hostile entries;/);
    const names = JSON.parse(log[0].split('first names ')[1]); assert.equal(names.length, 5);
    assert.equal(fs.readFileSync(join(f.o.spool, 'requests', 'bad-directory-0', 'child'), 'utf8'), 'never traverse');
    assert.ok(f.pending().length >= 110, 'hostile directories are never traversed');
});
test('pr-broker bounds hostile results per run and never republishes a reported leftover', async t => {
    const f = fixture(t), log = [];
    t.mock.method(console, 'error', line => log.push(line));
    for (let i = 0; i < 50; i++) {
        const dir = join(f.o.spool, 'requests', `bad-directory-${i}`);
        fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'child'), 'never traverse');
    }
    await f.run();
    assert.equal(f.results().length, 20); assert.equal(log.length, 1);
    assert.match(log[0], /refused 20 hostile entries;/);
    // The same leftovers are reported once, not published again.
    await f.run();
    assert.equal(f.results().length, 40); assert.equal(log.length, 2);
    assert.match(log[1], /refused 20 hostile entries;/);
    await f.run();
    assert.equal(f.results().length, 50); assert.equal(log.length, 3);
    await f.run();
    assert.equal(f.results().length, 50); assert.equal(log.length, 4);
    assert.match(log[3], /refused 0 hostile entries;/);
    assert.equal(f.pending().length, 50);
});
test('pr-broker never evicts a live leftover, so 501 leftovers are reported once each', async t => {
    const f = fixture(t), log = [];
    t.mock.method(console, 'error', line => log.push(line));
    // More leftovers than the report may remember: the ones over the cap are
    // never published, and the ones inside it are never published twice.
    for (let i = 0; i < 501; i++) {
        const dir = join(f.o.spool, 'requests', `bad-directory-${i}`);
        fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'child'), 'never traverse');
    }
    for (let run = 1; run <= 30; run++) {
        log.length = 0;
        await f.run();
        assert.ok(f.results().length <= 500, `run ${run}: ${f.results().length} results`);
        const report = JSON.parse(fs.readFileSync(join(f.o.state, 'hostile-report.json'), 'utf8'));
        assert.ok(report.length <= 500, `run ${run}: ${report.length} remembered leftovers`);
        for (const item of report)
            assert.ok(fs.existsSync(join(f.o.spool, 'requests', item.name)), `run ${run}: ${item.name} was evicted`);
    }
    // Every remembered leftover was reported exactly once and never again.
    assert.equal(f.results().length, 500);
    const report = JSON.parse(fs.readFileSync(join(f.o.state, 'hostile-report.json'), 'utf8'));
    assert.equal(report.length, 500);
    assert.equal(new Set(report.map(item => item.name)).size, 500);
    // The one leftover over the cap is reported as an aggregate warning, once
    // per run, and never as a result.
    assert.ok(log.some(line => /hostile leftovers over capacity: 1; operator cleanup needed/.test(line)), log.join('\n'));
    assert.ok(!log.some(line => /over capacity/.test(line) && /refused/.test(line)));
    // An identity whose entry is gone is pruned, and its room is free again.
    fs.rmSync(join(f.o.spool, 'requests', 'bad-directory-0'), { recursive: true });
    await f.run();
    const pruned = JSON.parse(fs.readFileSync(join(f.o.state, 'hostile-report.json'), 'utf8'));
    assert.equal(pruned.length, 500);
    assert.ok(!pruned.some(item => item.name === 'bad-directory-0'));
    // The freed room publishes the leftover that was over the cap, once.
    assert.equal(f.results().length, 501);
});
test('pr-broker result cleanup advances through every entry over successive runs', async t => {
    const f = fixture(t), results = join(f.o.spool, 'results');
    const old = Date.now() - 8 * 86400000;
    for (let i = 0; i < 2500; i++) {
        const file = join(results, `result-${i}.json`);
        fs.writeFileSync(file, '{}'); fs.utimesSync(file, new Date(old), new Date(old));
    }
    await f.run();
    assert.equal(fs.readdirSync(results).length, 1500, 'the first run only examines its budget');
    await f.run();
    assert.equal(fs.readdirSync(results).length, 1000);
    await f.run();
    assert.equal(fs.readdirSync(results).length, 0, 'every entry is reached over successive runs');
});
test('pr-broker writes error result and deletes input on classifier or authentication failure', async t => {
    const f = fixture(t); f.data.laneError = true; f.save();
    const a = f.request(); await f.run(); assert.equal(f.result(a).status, 'error');
    f.o.tokenProvider = async () => { throw Error('SECRET'); };
    const b = f.request(); await f.run(); assert.equal(f.result(b).status, 'error');
    assert.ok(!JSON.stringify(f.result(b)).includes('SECRET')); assert.deepEqual(f.pending(), []);
});
test('pr-broker enable files must be regular, root-owned and not group/world writable', t => {
    const f = fixture(t), file = join(f.o.config, 'requests.enabled');
    assert.equal(enabled(file), false); f.enable(); assert.equal(enabled(file), true);
    fs.chmodSync(file, 0o664); assert.equal(enabled(file), false);
    fs.unlinkSync(file); fs.symlinkSync('/dev/null', file); assert.equal(enabled(file), false);
    // For non-root ownership, bypass fixture's synthetic root stat.
    t.mock.method(fs, 'lstatSync', () => ({ isFile: () => true, uid: 1000, mode: 0o100644 }));
    assert.equal(enabled(file), false);
});
test('pr-broker mints a per-run RS256 installation token scoped to only home-ops and exact permissions', async t => {
    const f = fixture(t), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(join(f.o.config, 'client-id'), 'client-id');
    fs.writeFileSync(join(f.o.config, 'merger.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const calls = [];
    t.mock.method(global, 'fetch', async (url, init) => { calls.push({ url, init }); return { ok: true,
        json: async () => calls.length === 1 ? { id: 123 } : { token: 'minted-token' } }; });
    assert.equal(await mintToken(f.o.config), 'minted-token');
    assert.equal(calls[0].url, 'https://api.github.com/repos/janpuc/home-ops/installation');
    assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['home-ops'], permissions:
        { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read' } });
    const jwt = calls[0].init.headers.Authorization.slice(7), [header, claims, signature] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'client-id');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
});

test('pr-broker replay IDs never merge twice or replace the original result, even after result retention', async t => {
    const f = fixture(t); f.enable(); const result = f.request(), name = result.split('/').at(-1);
    await f.run(); const original = fs.readFileSync(result, 'utf8');
    const replay = () => fs.writeFileSync(join(f.o.spool, 'requests', name), JSON.stringify({ pr: 42, head }));
    replay(); await f.run(); assert.equal(fs.readFileSync(result, 'utf8'), original);
    fs.unlinkSync(result); replay(); await f.run();
    assert.match(f.result(result).reasons[0], /already processed/);
    assert.equal(f.calls().filter(c => c.tool === 'gh').length, 1);
});
test('pr-broker cleanup replacement cannot overwrite an existing result', async t => {
    const f = fixture(t), result = f.request(), name = result.split('/').at(-1);
    const input = join(f.o.spool, 'requests', name), unlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', file => {
        if (file === input) { unlink(file); fs.symlinkSync('/dev/null', input); throw Object.assign(Error('replaced'), { code: 'EPERM' }); }
        return unlink(file);
    });
    await f.run(); assert.equal(f.result(result).status, 'dry-run');
    assert.equal(f.results().length, 1);
});
test('pr-merge-request staging is invisible to a concurrent broker scan and cleanup', async t => {
    const f = fixture(t), rename = fs.renameSync; let interleaved;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(from).includes('/staging/')) {
            assert.ok(fs.existsSync(from));
            interleaved = f.run(); // Empty input scan and cleanup finish synchronously.
            assert.equal(f.results().length, 0); assert.ok(fs.existsSync(from));
        }
        return rename(from, to);
    });
    const result = f.request(); await interleaved;
    await f.run(); assert.equal(f.result(result).status, 'dry-run');
});
test('pr-broker trust check rejects non-root, writable ancestors, and unsafe runtime symlink targets', t => {
    const { assertTrusted } = require('./pr-broker');
    const stat = (uid = 0, mode = 0o755, link = false) => ({ uid, mode, isSymbolicLink: () => link });
    let unsafe = '/usr/local', bad = stat(1000);
    // One mock whose behaviour changes: a second t.mock.method on the same function would be
    // restored to the first mock, which then leaks into every later test.
    const lstat = t.mock.method(fs, 'lstatSync', path => path === unsafe ? bad : stat());
    assert.throws(() => assertTrusted(['/usr/local/sbin/pr-broker']), /untrusted/);
    bad = stat(0, 0o775); assert.throws(() => assertTrusted(['/usr/local/sbin/pr-lane']), /untrusted/);
    unsafe = '/opt/pr-broker/releases'; assert.throws(() => assertTrusted(['/opt/pr-broker/releases/node/bin/node']), /untrusted/);
    lstat.mock.mockImplementation(path => path === '/opt/pr-broker/bin/node' ? stat(0, 0o777, true) : path === '/home/pocket' ? stat(1000) : stat());
    t.mock.method(fs, 'readlinkSync', () => '/home/pocket/node');
    assert.throws(() => assertTrusted(['/opt/pr-broker/bin/node']), /untrusted/);
});
test('pr-broker request ledger fails closed at its bounded cap', t => {
    const f = fixture(t), { reserveRequest } = require('./pr-broker');
    const ids = Array.from({ length: 100000 }, () => `request-${randomUUID()}.json`);
    fs.writeFileSync(join(f.o.state, 'processed-requests.json'), JSON.stringify(ids));
    assert.equal(reserveRequest(f.o.state, ids[0]), false);
    assert.throws(() => reserveRequest(f.o.state, `request-${randomUUID()}.json`), /ledger full/);
});

// Approve-to-merge: Jan approves a PR in GitHub and the broker merges that exact head.
const { latestDecision } = require('./pr-broker');
const jan = { login: 'janpuc', id: 8539508, type: 'User' };
const review = (id, state, commit_id, user = jan, submitted_at = `2026-11-02T10:0${id}:00Z`) => ({ id, state, commit_id, user, submitted_at });
const openPr = (number, sha, extra = {}) => ({ number, draft: false, base: { ref: 'main', repo: { full_name: 'janpuc/home-ops' } },
    head: { sha, repo: { full_name: 'janpuc/home-ops' } }, ...extra });
function approvedFixture(t, { lane = 'C', reviews = [review(1, 'APPROVED', head)], pr = openPr(42, head), facts = {},
    reasons = ['kritika P1 finding'], waiting = lane === 'wait' ? reasons : [] } = {}) {
    const f = fixture(t);
    f.data.prs = [{ pr: 42, head, lane, reasons, waiting, facts: { createdAt: '2026-01-01', ...facts } }];
    f.data.api = { 'repos/janpuc/home-ops/pulls?state=open&per_page=100': [pr], 'repos/janpuc/home-ops/pulls/42/reviews?per_page=100': reviews };
    f.save();
    return f;
}
const merges = f => f.calls().filter(c => c.tool === 'gh' && c.args.includes('PUT'));
const comments = f => f.calls().filter(c => c.tool === 'gh' && c.args.includes('POST'));

test('approved: only Jan by login and id, his newest decision, on the current head', () => {
    const bot = { login: 'janpuc', id: 1, type: 'User' }, app = { login: 'janpuc', id: 8539508, type: 'Bot' };
    assert.equal(latestDecision([review(1, 'APPROVED', head)])?.state, 'APPROVED');
    assert.equal(latestDecision([review(1, 'APPROVED', head, bot)]), null);
    assert.equal(latestDecision([review(1, 'APPROVED', head, app)]), null);
    assert.equal(latestDecision([review(1, 'APPROVED', head), review(2, 'CHANGES_REQUESTED', head)])?.state, 'CHANGES_REQUESTED');
    assert.equal(latestDecision([review(1, 'DISMISSED', head)])?.state, 'DISMISSED');
    assert.equal(latestDecision([review(1, 'APPROVED', head), review(2, 'COMMENTED', head)])?.state, 'APPROVED');
});

test('approved: Jan\'s approval merges a lane C PR, pinned to the approved head; dry-run without the switch', async t => {
    const dry = approvedFixture(t);
    assert.equal(await dry.run('approved'), true);
    assert.deepEqual(merges(dry), []);
    assert.equal(dry.results()[0].status, 'dry-run');
    const f = approvedFixture(t);
    f.enable('approved');
    assert.equal(await f.run('approved'), true);
    assert.deepEqual(merges(f).map(c => c.args), [['api', '-X', 'PUT', 'repos/janpuc/home-ops/pulls/42/merge', '-f', 'merge_method=squash', '-f', `sha=${head}`]]);
    assert.ok(merges(f)[0].tokenPresent);
    assert.equal(f.results()[0].status, 'merged');
    assert.equal(f.results()[0].lane, 'C');
});

test('approved: no merge for an older commit, a later change request, someone else, a fork, a draft or a full review page', async t => {
    const other = 'b'.repeat(40);
    for (const options of [
        { reviews: [review(1, 'APPROVED', other)] },
        { reviews: [review(1, 'APPROVED', head), review(2, 'CHANGES_REQUESTED', head)] },
        { reviews: [review(1, 'APPROVED', head, { login: 'bot-atlas[bot]', id: 2291895, type: 'Bot' })] },
        { pr: openPr(42, head, { head: { sha: head, repo: { full_name: 'someone/home-ops' } } }) },
        { pr: openPr(42, head, { draft: true }) },
        { reviews: Array.from({ length: 100 }, (_, i) => review(i, 'APPROVED', head)) },
    ]) {
        const f = approvedFixture(t, options);
        f.enable('approved');
        assert.equal(await f.run('approved'), true);
        assert.deepEqual(merges(f), [], JSON.stringify(options).slice(0, 80));
        assert.deepEqual(f.calls().filter(c => c.tool === 'lane'), []);
    }
});

test('approved: failed CI refuses and tells Jan once per head; kritika alone does not block', async t => {
    const f = approvedFixture(t, { facts: { checks: [{ name: 'Build Success', status: 'completed', conclusion: 'failure' }],
        statuses: [{ context: 'Kritika / Review', state: 'failure' }] } });
    f.enable('approved');
    assert.equal(await f.run('approved'), true);
    assert.equal(await f.run('approved'), true);
    assert.deepEqual(merges(f), []);
    assert.equal(comments(f).length, 1);
    assert.match(comments(f)[0].args.at(-1), /^body=Not merged: your approval is for `aaaaaaa`, but CI failed on it:\n- failed check: Build Success \(failure\)/);
    assert.equal(f.results().length, 1, 'one result per outcome, not per run');
    assert.deepEqual(f.results()[0].reasons, ['failed check: Build Success (failure)']);
});

test('approved: missing evidence waits quietly, and tells Jan once after an hour', async t => {
    const f = approvedFixture(t, { lane: 'wait' });
    f.enable('approved');
    assert.equal(await f.run('approved'), true);
    assert.deepEqual(merges(f), []);
    assert.deepEqual(comments(f), []);
    assert.equal(f.results()[0].status, 'waiting');
    const notes = join(f.o.state, 'approved-notes.json');
    const stored = JSON.parse(fs.readFileSync(notes, 'utf8'));
    stored[`42@${head}`].since -= 2 * 3600000;
    fs.writeFileSync(notes, JSON.stringify(stored));
    assert.equal(await f.run('approved'), true);
    assert.equal(await f.run('approved'), true);
    assert.equal(comments(f).length, 1);
    assert.match(comments(f)[0].args.at(-1), /has waited an hour for:\n- kritika P1 finding/);
});

test('approved: a failed comment fails the run and is tried again; notes forget withdrawn approvals', async t => {
    const f = approvedFixture(t, { facts: { checks: [{ name: 'Zizmor', status: 'completed', conclusion: 'failure' }] } });
    f.enable('approved');
    f.data.failComment = true; f.save();
    assert.equal(await f.run('approved'), false);
    f.data.failComment = false; f.save();
    assert.equal(await f.run('approved'), true);
    assert.equal(comments(f).length, 2);
    f.data.api['repos/janpuc/home-ops/pulls/42/reviews?per_page=100'] = [review(1, 'DISMISSED', head)]; f.save();
    assert.equal(await f.run('approved'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(f.o.state, 'approved-notes.json'), 'utf8')), {});
});

test('approved: an agent PR waits only on advisory reasons, so Jan\'s approval merges it', async t => {
    const noTable = 'Renovate update type not derivable from PR body: no update table before the release notes in PR body';
    const f = approvedFixture(t, { lane: 'wait', waiting: [noTable, 'kritika comment missing or stale for head'],
        reasons: [noTable, 'kritika comment missing or stale for head', 'author is not bot-atlas', 'kritika P1 finding'] });
    f.enable('approved');
    assert.equal(await f.run('approved'), true);
    assert.equal(merges(f).length, 1);
    assert.equal(f.results()[0].status, 'merged');
});

test('approved: evidence still coming holds, and an old pr-lane without its wait list holds everything', async t => {
    const pending = approvedFixture(t, { lane: 'wait', waiting: ['check or status pending', 'Renovate update type not derivable from PR body: x'],
        reasons: ['check or status pending', 'Renovate update type not derivable from PR body: x'] });
    pending.enable('approved');
    assert.equal(await pending.run('approved'), true);
    assert.deepEqual(merges(pending), []);
    assert.deepEqual(pending.results()[0].reasons, ['check or status pending']);
    const old = approvedFixture(t, { lane: 'wait', reasons: ['Renovate update type not derivable from PR body: x'] });
    delete old.data.prs[0].waiting; old.save();
    old.enable('approved');
    assert.equal(await old.run('approved'), true);
    assert.deepEqual(merges(old), []);
    assert.equal(old.results()[0].status, 'waiting');
});

test('approved: the agent changing the PR or kritika\'s comment refuses, and Jan is told once', async t => {
    const f = approvedFixture(t, { reasons: ['kritika comment edited by janpuc-agent', 'kritika P1 finding'] });
    f.enable('approved');
    assert.equal(await f.run('approved'), true);
    assert.equal(await f.run('approved'), true);
    assert.deepEqual(merges(f), []);
    assert.equal(f.results()[0].status, 'refused');
    assert.equal(comments(f).length, 1);
    assert.match(comments(f)[0].args.at(-1), /^body=Not merged: the agent's App changed this PR or kritika's review after the fact:\n- kritika comment edited by janpuc-agent/);
});
