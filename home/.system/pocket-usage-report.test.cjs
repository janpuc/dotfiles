'use strict';
// pocket-usage-report against a fixture Pi Pocket database and fake Pi Pocket, Prometheus and
// Pushover servers. Run with `node --test home/.system/pocket-usage-report.test.cjs`.
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const script = path.join(__dirname, 'pocket-usage-report');
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'pocket-usage-report.json'), 'utf8'));
const TOKEN = 'owner-token-that-must-never-be-printed';
const PUSH_TOKEN = 'pushover-app-token-never-printed';
const HOUR = 3600 * 1000;
// 2026-11-04 07:50 in Warsaw (CET, UTC+1).
const NOW = Date.UTC(2026, 10, 4, 6, 50);

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function body(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => resolve(raw));
    });
}

// Sessions: [id, owner|null]; calls: [conversation, minutes ago, context, output].
function fixtureDb(dir, sessions, calls, now) {
    const db = path.join(dir, 'pocket.sqlite');
    const rows = { sessions, calls: calls.map(([c, ago, context, output]) => [c, now - ago * 60000, context, output]) };
    execFileSync('python3', ['-I', '-c', `
import json, sqlite3, sys
rows = json.loads(sys.argv[2])
db = sqlite3.connect(sys.argv[1])
db.execute("create table conversations (id integer primary key, owner_conversation_id, owner_task_id, record)")
db.execute("create table tasks (id integer primary key, conversation_id, kind, status, abort_requested, background, record)")
db.execute("create table entries (id integer primary key, conversation_id, head, commit_seq, record)")
for sid, owner in rows["sessions"]:
    db.execute("insert into conversations values (?, ?, null, ?)", (sid, owner, json.dumps({"id": sid})))
for n, (conv, at, context, output) in enumerate(rows["calls"], start=1):
    db.execute("insert into tasks values (?, ?, 'pi.generation', 'terminal', 0, 0, ?)", (n, conv, json.dumps({"startedAt": at})))
    usage = {"input": 100, "output": output, "cacheRead": context - 100, "cacheWrite": 0, "totalTokens": context + output}
    entry = {"kind": "pi.assistant", "byTaskId": n, "model": [{"role": "assistant", "model": "MiniMax-M3.1-Flash", "usage": usage}]}
    db.execute("insert into entries values (?, ?, 1, 1, ?)", (10000 + n, conv, json.dumps(entry)))
db.commit()
`, db, JSON.stringify(rows)]);
    return db;
}

async function fakes(t, { prometheusUp = true } = {}) {
    const pushes = [];
    const posts = [];
    const pocket = await listen((req, res) => {
        if (req.method === 'POST') posts.push(req.url);
        res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.method === 'POST' ? { ok: true }
            : [{ id: 1356, title: 'PRs' }, { id: 548, title: 'Alerts' }, { id: 3120, title: 'Home' }, { id: 4242, title: 'Chat' }]));
    });
    const prom = await listen((req, res) => {
        if (!prometheusUp) { res.writeHead(503); res.end(); return; }
        const query = new URL(req.url, 'http://x').searchParams.get('query');
        const result = query.includes('fallbacks')
            ? [{ metric: { requested_model: 'minimax/MiniMax-M3', fallback_model: 'opencode-go/minimax-m3' }, value: [0, '12'] },
                { metric: { requested_model: 'opencode-go/kimi-k3', fallback_model: 'minimax/MiniMax-M3' }, value: [0, '4'] }]
            : [{ metric: { requested_model: 'minimax/MiniMax-M3.1-Flash' }, value: [0, '70000000'] },
                { metric: { requested_model: 'opencode-go/deepseek-v4.1-flash' }, value: [0, '1100000'] }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data: { result } }));
    });
    const pushover = await listen(async (req, res) => {
        pushes.push(Object.fromEntries(new URLSearchParams(await body(req))));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":1}');
    });
    t.after(() => { pocket.close(); prom.close(); pushover.close(); });
    const url = (s) => `http://127.0.0.1:${s.address().port}`;
    return { pocketUrl: url(pocket), promUrl: url(prom), pushUrl: `${url(pushover)}/1/messages.json`, pushes, posts };
}

async function run(t, f, { sessions, calls, state, args = [], now = NOW }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-usage-report-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, 'pocket.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ ownerToken: TOKEN }));
    const envFile = path.join(dir, 'pushover.env');
    fs.writeFileSync(envFile, `PUSHOVER_TOKEN=${PUSH_TOKEN}\nPUSHOVER_USER=user-key\n`);
    const limits = path.join(dir, 'limits.json');
    fs.writeFileSync(limits, JSON.stringify({ gates: [{ state: 'waiting', provider: 'minimax', until: now + HOUR }] }));
    const breaker = path.join(dir, 'breaker.json');
    const config = { ...shipped, db: fixtureDb(dir, sessions, calls, now), limits, breaker: { ...shipped.breaker, file: breaker },
        pocket: { ...shipped.pocket, baseUrl: f.pocketUrl, tokenFile }, prometheus: f.promUrl,
        pushover: { envFile, url: f.pushUrl } };
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const stateFile = path.join(dir, 'state.json');
    if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = await new Promise((resolve) => {
        execFile('python3', ['-I', script, '--config', configFile, '--state', stateFile, '--now', String(now), ...args],
            { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.ok(!out.includes(TOKEN) && !out.includes(PUSH_TOKEN), 'no token is ever printed');
    return { ...result, state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null,
        breaker: fs.existsSync(breaker) ? { ...JSON.parse(fs.readFileSync(breaker, 'utf8')), mode: fs.statSync(breaker).mode & 0o777 } : null };
}

const quiet = { sessions: [[1356, null], [548, null], [9001, 1356]], calls: [
    [1356, 60, 40000, 800], [1356, 30, 42000, 900], [9001, 20, 15000, 300], [548, 10, 30000, 500],
] };

test('the daily summary goes out quietly at the report hour, once a day', async (t) => {
    const f = await fakes(t);
    const first = await run(t, f, quiet);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(f.pushes.length, 1);
    const [push] = f.pushes;
    assert.equal(push.priority, '-1');
    assert.equal(push.token, PUSH_TOKEN);
    assert.match(push.title, /^Agents, last 24 h: \d/);
    assert.match(push.message, /LiteLLM 71M: MiniMax-M3\.1-Flash 70M, deepseek-v4\.1-flash 1\.1M/);
    assert.match(push.message, /Paid fallbacks to OpenCode Go: 12/, 'only fallbacks into OpenCode Go count');
    assert.match(push.message, /Waiting on: minimax until/);
    assert.match(push.message, /3 more sessions under 1M|2 more sessions under 1M/);
    assert.equal(first.state.reported, '2026-11-04');

    const again = await run(t, f, { ...quiet, state: first.state });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(f.pushes.length, 1, 'no second summary the same day');
});

test('a subagent counts with the session that started it', async (t) => {
    const f = await fakes(t);
    const big = { sessions: [[1356, null], [9001, 1356]], calls: Array.from({ length: 40 }, (_, i) => [i % 2 ? 9001 : 1356, i, 50000, 100]) };
    await run(t, f, big);
    assert.match(f.pushes[0].message, /^PRs: 2\.0M, 40 calls, ~50K a call/);
});

test('a runaway session is pushed at once, at normal priority, and only once a day', async (t) => {
    const f = await fakes(t);
    const heavy = { sessions: [[4242, null]], calls: Array.from({ length: 12 }, (_, i) => [4242, 5 * i, 500000, 1000]) };
    const at = NOW + 3 * HOUR; // not the report hour
    const first = await run(t, f, { ...heavy, now: at });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(f.pushes.length, 1);
    assert.equal(f.pushes[0].priority, '0');
    assert.equal(f.pushes[0].title, 'Runaway agent: Chat');
    assert.match(f.pushes[0].message, /each call re-reads ~500K tokens \(12 calls in 2 h\)/);

    const again = await run(t, f, { ...heavy, now: at + HOUR, state: first.state });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(f.pushes.length, 1, 'the same runaway is not pushed again within a day');
});

test('too many tokens in a day is a runaway too', async (t) => {
    const f = await fakes(t);
    const many = { sessions: [[4242, null]], calls: Array.from({ length: 5 }, (_, i) => [4242, 300 + i, 25000000, 1000]) };
    const result = await run(t, f, { ...many, now: NOW + 3 * HOUR });
    assert.equal(f.pushes.length, 1);
    assert.match(f.pushes[0].message, /^Chat on aether: 125M tokens in 24 h \(5 calls\)/);
    assert.deepEqual(f.posts, [], 'a session outside the breaker is never stopped');
    assert.equal(result.breaker, null);
});

test('Prometheus down still sends the summary, saying so', async (t) => {
    const f = await fakes(t, { prometheusUp: false });
    const result = await run(t, f, quiet);
    assert.equal(result.code, 0, result.stderr);
    assert.match(f.pushes[0].message, /LiteLLM: no numbers \(Prometheus did not answer\)/);
});

test('--dry-run prints and sends nothing, --report sends the summary at any hour', async (t) => {
    const f = await fakes(t);
    const result = await run(t, f, { ...quiet, now: NOW + 5 * HOUR, args: ['--dry-run', '--report'] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.pushes.length, 0);
    assert.match(result.stdout, /\[priority -1\] Agents, last 24 h:/);
    assert.equal(result.state, null, 'a dry run writes no state');
});

test('shipped config: Pushover keys in a root-only file, quiet summary at 07:00 Warsaw hour', () => {
    assert.equal(shipped.pushover.envFile, '/etc/pocket-usage-report/pushover.env');
    assert.equal(shipped.reportHour, 7);
    assert.equal(shipped.db, '/home/pocket/.pi-pocket/pocket.sqlite');
});

test('the breaker: a background session over 15M tokens in 24 h is stopped, paused until midnight, pushed once', async (t) => {
    const f = await fakes(t);
    const heavy = { sessions: [[548, null], [9001, 548]], calls: Array.from({ length: 8 }, (_, i) => [i % 2 ? 9001 : 548, 300 + i, 2000000, 1000]) };
    const at = NOW + 3 * HOUR; // 10:50 in Warsaw
    const first = await run(t, f, { ...heavy, now: at, state: { breakerSince: 0 } });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(f.posts, ['/api/c/548/abort'], 'the root session is stopped, subagents counted with it');
    assert.equal(f.pushes.length, 1);
    assert.equal(f.pushes[0].title, 'Breaker: Alerts stopped');
    assert.match(f.pushes[0].message, /^Alerts on aether: 16M tokens in 24 h \(8 calls\)\. Its run stopped, and its scheduled passes are paused until midnight\./);
    assert.equal(first.breaker.mode, 0o644, 'pocket-watchdog reads it as pocket');
    assert.equal(first.breaker.paused['548'].until, Date.UTC(2026, 10, 4, 23, 0), 'midnight in Warsaw');
    assert.match(first.breaker.paused['548'].reason, /16M tokens in 24 h/);

    const again = await run(t, f, { ...heavy, now: at + HOUR, state: first.state });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(f.pushes.length, 1, 'pushed once');
    assert.equal(f.posts.length, 1, 'stopped once');
});

test('the breaker: calls that each re-read over 120K trip it; the same calls in a session outside it do not', async (t) => {
    const f = await fakes(t);
    const calls = (sid) => Array.from({ length: 3 }, (_, i) => [sid, 10 * i, 130000, 500]);
    const trips = await run(t, f, { sessions: [[1356, null]], calls: calls(1356), now: NOW + 3 * HOUR, state: { breakerSince: 0 } });
    assert.equal(trips.code, 0, trips.stderr);
    assert.equal(f.pushes[0].title, 'Breaker: PRs stopped');
    assert.match(f.pushes[0].message, /each call re-reads ~130K tokens \(3 calls in 2 h\)/);

    const g = await fakes(t);
    const other = await run(t, g, { sessions: [[4242, null]], calls: calls(4242), now: NOW + 3 * HOUR, state: { breakerSince: 0 } });
    assert.equal(other.code, 0, other.stderr);
    assert.deepEqual(g.pushes, []);
    assert.deepEqual(g.posts, []);
});

test('the breaker in a dry run stops nothing and writes no pause', async (t) => {
    const f = await fakes(t);
    const result = await run(t, f, { sessions: [[1356, null]], calls: Array.from({ length: 8 }, (_, i) => [1356, 300 + i, 2000000, 1000]),
        now: NOW + 3 * HOUR, args: ['--dry-run'], state: { breakerSince: 0 } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[breaker\] would stop PRs \(1356\)/);
    assert.deepEqual(f.posts, []);
    assert.equal(result.breaker, null);
});

test('shipped config: the breaker guards the five background sessions at 15M a day and 120K a call', () => {
    assert.deepEqual(shipped.breaker.sessions, [548, 1356, 1838, 3120, 7766]);
    assert.equal(shipped.breaker.tokens24h, 15000000);
    assert.equal(shipped.breaker.contextPerCall, 120000);
    assert.equal(shipped.breaker.file, '/var/lib/pocket-usage-report/breaker.json');
    const watchdog = JSON.parse(fs.readFileSync(path.join(__dirname, 'pocket-watchdog.json'), 'utf8'));
    assert.equal(watchdog.breakerFile, shipped.breaker.file);
});

test('the breaker counts from its first run: usage from before it was deployed does not trip it', async (t) => {
    const f = await fakes(t);
    const before = { sessions: [[1356, null]], calls: Array.from({ length: 8 }, (_, i) => [1356, 300 + i, 2000000, 1000]) };
    const first = await run(t, f, { ...before, now: NOW + 3 * HOUR });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(f.posts, []);
    assert.deepEqual(f.pushes, []);
    assert.equal(first.state.breakerSince, NOW + 3 * HOUR);
});
