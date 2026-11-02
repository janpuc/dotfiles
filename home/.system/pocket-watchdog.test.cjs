// The pocket watchdog against a fake Pi Pocket and a fake Alertmanager: nothing here touches a
// real server, a real session or a real alert. The script runs as a child process, without
// blocking this one, so the fake servers can answer it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'pocket-watchdog');
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'pocket-watchdog.json'), 'utf8'));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TOKEN = 'owner-token-that-must-never-be-printed';
const PRS = 1356;

const METERED = [
    { provider: 'minimax', id: 'MiniMax-M3.1-Flash' },
    { provider: 'openai', id: 'gpt-6.1-sol' },
    { provider: 'anthropic', id: 'claude-sonnet-5-5' },
];
const LOCAL = { provider: 'm3pro', id: 'huihui-qwen3.8-27b' };

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
        req.on('end', () => {
            try { resolve(raw === '' ? null : JSON.parse(raw)); } catch { resolve(raw); }
        });
    });
}

// A fake Pi Pocket with one session, the PRs one, in the shape the real API answers.
async function fakePocket(t, { models = [...METERED, LOCAL], meta = {}, view }) {
    const posts = [];
    const server = await listen(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const data = await body(req);
        const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers['x-pocket'] !== '1') return reply(401, { error: 'no' });
        if (req.method === 'GET' && url.pathname === '/api/me') return reply(200, { models });
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
            return reply(200, [{ id: PRS, busy: false, waiting: false, updatedAt: Date.now(), ...meta }]);
        }
        if (req.method === 'GET' && url.pathname === '/api/poll') {
            if (url.searchParams.get('close') === '1') return reply(200, { ok: true });
            return reply(200, { session: 'poller', events: [{ seq: 1, event: 'view', data: { full: true, approvals: [], subagents: [], ...view } }] });
        }
        if (req.method === 'POST') { posts.push({ path: url.pathname, body: data }); return reply(200, { ok: true }); }
        return reply(404, { error: 'unknown route' });
    });
    t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}`, posts };
}

async function fakeAlertmanager(t) {
    const alerts = [];
    const server = await listen(async (req, res) => {
        const data = await body(req);
        if (req.method === 'POST' && req.url === '/api/v2/alerts') alerts.push(...data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });
    t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}/api/v2/alerts`, alerts };
}

// One watchdog run over the shipped PRs chain, with the fake servers and an optional state.
async function run(t, { pocketUrl, alertUrl, state }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-watchdog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, 'pocket.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ ownerToken: TOKEN }), { mode: 0o600 });
    const config = {
        pocket: { baseUrl: pocketUrl, tokenFile, tokenKey: 'ownerToken' },
        alertmanager: { url: alertUrl },
        sessions: shipped.sessions.filter((session) => session.id === PRS),
    };
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const stateFile = path.join(dir, 'state.json');
    if (state) fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { [PRS]: state } }));
    const result = await new Promise((resolve) => {
        execFile('python3', ['-I', script, '--config', configFile, '--state', stateFile], { encoding: 'utf8' },
            (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN), 'the owner token is never printed');
    const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions[PRS] : null;
    return { ...result, state: saved };
}

const onModel = (provider, modelId) => ({ agent: { model: { provider, modelId } } });
const limitError = (id, at) => ({ id, kind: 'assistant', at, stopReason: 'error',
    error: "OpenAI's usage limit. Not waiting: it did not clear in 6 h." });
const answer = (id, at) => ({ id, kind: 'assistant', at, stopReason: 'stop', blocks: [{ type: 'text', text: 'done' }] });
const configures = (posts) => posts.filter((post) => post.path.endsWith('/configure')).map((post) => post.body.model);
const submits = (posts) => posts.filter((post) => post.path.endsWith('/submit'));

test('shipped config: every session has a chain ending on the M3 Pro', () => {
    assert.deepEqual(shipped.sessions.map((session) => session.id).sort((a, b) => a - b), [548, 1356, 1838, 3120, 7766]);
    for (const session of shipped.sessions) assert.equal(session.chain.at(-1), 'm3pro/huihui-qwen3.8-27b:off');
});

test('a limit failure moves the session to the next model and tells it once', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'), live: { busy: false },
        entries: [answer(1, now - 3 * HOUR), limitError(2, now - 5 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'openai', modelId: 'gpt-6.1-sol' }]);
    assert.equal(submits(pocket.posts).length, 1);
    assert.match(submits(pocket.posts)[0].body.text, /MiniMax's usage limit ran out\. You now run on gpt-6\.1-sol\./);
    assert.equal(result.state.handledFailure, 2);
    assert.equal(result.state.model, 'openai/gpt-6.1-sol');
    assert.equal(am.alerts.length, 0);
});

test('the same failure seen again is not a new one: no second switch, and a page after 30 minutes', async (t) => {
    const now = Date.now();
    const view = { ...onModel('openai', 'gpt-6.1-sol'), live: { busy: false }, entries: [limitError(2, now - 40 * MINUTE)] };
    const state = (handledAt) => ({ model: 'openai/gpt-6.1-sol', fallbackSince: handledAt, handledFailure: 2, handledAt,
        failures: { 'minimax/MiniMax-M3.1-Flash': handledAt } });

    const fresh = await fakePocket(t, { view });
    const am1 = await fakeAlertmanager(t);
    const soon = await run(t, { pocketUrl: fresh.url, alertUrl: am1.url, state: state(now - 10 * MINUTE) });
    assert.equal(soon.code, 0, soon.stderr);
    assert.deepEqual(fresh.posts, []);
    assert.equal(am1.alerts.length, 0);

    const stale = await fakePocket(t, { view });
    const am2 = await fakeAlertmanager(t);
    const late = await run(t, { pocketUrl: stale.url, alertUrl: am2.url, state: state(now - 40 * MINUTE) });
    assert.equal(late.code, 0, late.stderr);
    assert.deepEqual(stale.posts, []);
    assert.equal(am2.alerts.length, 1);
    assert.match(am2.alerts[0].annotations.summary, /^The PRs agent on aether has stopped: it ran out of quota and did not start again/);
});

test('a second limit failure on the fallback moves on to the third model', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('openai', 'gpt-6.1-sol'), live: { busy: false },
        entries: [limitError(2, now - 2 * HOUR), answer(3, now - HOUR), limitError(4, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'openai/gpt-6.1-sol',
        fallbackSince: now - 2 * HOUR, handledFailure: 2, handledAt: now - 2 * HOUR, failures: { 'minimax/MiniMax-M3.1-Flash': now - 2 * HOUR } } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'anthropic', modelId: 'claude-sonnet-5-5' }]);
    assert.equal(submits(pocket.posts).length, 1);
    assert.equal(am.alerts.length, 0);
});

test('a long limit wait stops the run, switches, and starts it again', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { meta: { busy: true }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
        live: { busy: true, limit: { provider: 'minimax', until: now + 3 * HOUR, reason: "MiniMax's usage limit" } },
        entries: [answer(1, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(pocket.posts.map((post) => post.path.split('/').at(-1)), ['configure', 'abort', 'submit']);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'openai', modelId: 'gpt-6.1-sol' }]);
});

test('a wait met after hours of quiet is not old: it is counted from the run that saw it', async (t) => {
    const now = Date.now();
    const view = { ...onModel('minimax', 'MiniMax-M3.1-Flash'), live: { busy: true, limit: { provider: 'minimax', until: now + 10 * MINUTE } },
        entries: [answer(1, now - 5 * HOUR)] };
    const first = await fakePocket(t, { meta: { busy: true }, view });
    const am1 = await fakeAlertmanager(t);
    const fresh = await run(t, { pocketUrl: first.url, alertUrl: am1.url });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.deepEqual(first.posts, [], 'no switch for a wait that clears in 10 minutes');
    assert.equal(am1.alerts.length, 0, 'a limit wait is not a hang');
    assert.ok(fresh.state.waitSince >= now);

    // Without a reset time, a wait that has lasted 30 minutes moves on.
    const unknown = { ...view, live: { busy: true, limit: { provider: 'minimax' } } };
    const second = await fakePocket(t, { meta: { busy: true }, view: unknown });
    const am2 = await fakeAlertmanager(t);
    const old = await run(t, { pocketUrl: second.url, alertUrl: am2.url, state: { model: 'minimax/MiniMax-M3.1-Flash',
        fallbackSince: null, failures: {}, waitSince: now - 40 * MINUTE } });
    assert.equal(old.code, 0, old.stderr);
    assert.deepEqual(configures(second.posts), [{ provider: 'openai', modelId: 'gpt-6.1-sol' }]);
    assert.equal(am2.alerts.length, 0, 'the run that switched does not page');
    assert.equal(old.state.waitSince, undefined);
});

test('old limit failures do not page once the session runs again', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('anthropic', 'claude-sonnet-5-5'), live: { busy: false }, entries: [answer(6, now - 5 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'anthropic/claude-sonnet-5-5', fallbackSince: now - HOUR,
        failures: { 'minimax/MiniMax-M3.1-Flash': now - 3 * HOUR, 'openai/gpt-6.1-sol': now - 2 * HOUR, 'anthropic/claude-sonnet-5-5': now - HOUR,
            'm3pro/huihui-qwen3.8-27b': now - HOUR } } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(pocket.posts, []);
    assert.equal(am.alerts.length, 0);
});

test('a limit that resets within two hours is waited out, however long the wait has lasted', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { meta: { busy: true }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
        live: { busy: true, limit: { provider: 'minimax', until: now + 90 * MINUTE } }, entries: [answer(1, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'minimax/MiniMax-M3.1-Flash',
        fallbackSince: null, failures: {}, waitSince: now - 3 * HOUR } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(pocket.posts, []);
    assert.equal(am.alerts.length, 0);
});

test('a switch remembers the reset, and the session goes back to its primary once it has passed', async (t) => {
    const now = Date.now();
    const waiting = await fakePocket(t, { meta: { busy: true }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
        live: { busy: true, limit: { provider: 'minimax', until: now + 3 * HOUR } }, entries: [answer(1, now - 2 * MINUTE)] } });
    const am1 = await fakeAlertmanager(t);
    const switched = await run(t, { pocketUrl: waiting.url, alertUrl: am1.url });
    assert.equal(switched.code, 0, switched.stderr);
    assert.equal(switched.state.resets.minimax, now + 3 * HOUR);

    const idle = { ...onModel('openai', 'gpt-6.1-sol'), live: { busy: false }, entries: [answer(3, now - 10 * MINUTE)] };
    for (const [reset, back] of [[now + HOUR, false], [now - MINUTE, true]]) {
        const pocket = await fakePocket(t, { view: idle });
        const am = await fakeAlertmanager(t);
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'openai/gpt-6.1-sol',
            fallbackSince: now - 2 * HOUR, failures: {}, resets: { minimax: reset } } });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(configures(pocket.posts), back ? [{ provider: 'minimax', modelId: 'MiniMax-M3.1-Flash' }] : []);
        if (back) assert.equal(result.state.resets.minimax, undefined);
    }
});

test('a spent chain pages Jan once, with a plain sentence first', async (t) => {
    const now = Date.now();
    const spent = { 'minimax/MiniMax-M3.1-Flash': now - 3 * HOUR, 'openai/gpt-6.1-sol': now - 2 * HOUR, 'anthropic/claude-sonnet-5-5': now - HOUR };
    const pocket = await fakePocket(t, { view: { ...onModel('m3pro', 'huihui-qwen3.8-27b'), live: { busy: false },
        entries: [limitError(9, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'm3pro/huihui-qwen3.8-27b',
        fallbackSince: now - HOUR, failures: spent } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), []);
    assert.equal(am.alerts.length, 1);
    const [alert] = am.alerts;
    assert.equal(alert.labels.alertname, 'PocketSessionStuck');
    assert.equal(alert.labels.severity, 'critical');
    assert.equal(alert.labels.session, 'PRs');
    assert.equal(alert.annotations.summary, 'The PRs agent on aether has stopped: every model it can use is out of quota.');
    assert.ok(Date.parse(alert.endsAt) > now + 30 * MINUTE);
});

test('a link Pi Pocket does not know is skipped, and the chain is spent without it', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { models: METERED, view: { ...onModel('anthropic', 'claude-sonnet-5-5'), live: { busy: false },
        entries: [limitError(5, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'anthropic/claude-sonnet-5-5',
        fallbackSince: now - HOUR, failures: { 'minimax/MiniMax-M3.1-Flash': now - 3 * HOUR, 'openai/gpt-6.1-sol': now - 2 * HOUR } } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipping m3pro\/huihui-qwen3\.8-27b: Pi Pocket does not know that model/);
    assert.deepEqual(configures(pocket.posts), []);
    assert.equal(am.alerts.length, 1);
    assert.match(am.alerts[0].annotations.summary, /every model it can use is out of quota/);
});

test('working for over two hours without news pages Jan; under two hours does not', async (t) => {
    const now = Date.now();
    for (const [age, pages] of [[3 * HOUR, 1], [HOUR, 0]]) {
        const pocket = await fakePocket(t, { meta: { busy: true }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
            live: { busy: true }, entries: [answer(1, now - age)] } });
        const am = await fakeAlertmanager(t);
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(pocket.posts, []);
        assert.equal(am.alerts.length, pages, `age ${age / HOUR} h`);
        if (pages) assert.match(am.alerts[0].annotations.summary, /working for hours without a word/);
    }
});

test('an idle session half a day on a fallback goes back to its primary model', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('openai', 'gpt-6.1-sol'), live: { busy: false }, entries: [answer(3, now - HOUR)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'openai/gpt-6.1-sol', fallbackSince: now - 13 * HOUR, failures: {} } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'minimax', modelId: 'MiniMax-M3.1-Flash' }]);
    assert.equal(submits(pocket.posts).length, 0);
    assert.equal(result.state.fallbackSince, null);
});

test('a failure that is not a limit pages only after 30 minutes and changes no model', async (t) => {
    const now = Date.now();
    const broken = (id, at) => ({ id, kind: 'assistant', at, stopReason: 'error', error: 'context window exceeded' });
    for (const [age, pages] of [[10 * MINUTE, 0], [40 * MINUTE, 1]]) {
        const pocket = await fakePocket(t, { meta: { endedAt: now - age }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
            live: { busy: false }, entries: [broken(7, now - age)] } });
        const am = await fakeAlertmanager(t);
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(pocket.posts, []);
        assert.equal(am.alerts.length, pages);
        if (pages) assert.match(am.alerts[0].annotations.summary, /failed with an error that is not a quota problem/);
    }
});

test('Pi Pocket unreachable: non-zero exit, no state, no alert', async (t) => {
    const am = await fakeAlertmanager(t);
    const closed = await listen(() => {});
    const port = closed.address().port;
    await new Promise((done) => closed.close(done));
    const result = await run(t, { pocketUrl: `http://127.0.0.1:${port}`, alertUrl: am.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Pi Pocket is not reachable/);
    assert.equal(result.state, null);
    assert.equal(am.alerts.length, 0);
});

test('a refused alert fails the run but the state is still saved', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { meta: { busy: true }, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'),
        live: { busy: true }, entries: [answer(1, now - 3 * HOUR)] } });
    const refusing = await listen((req, res) => { res.writeHead(500); res.end('down'); });
    t.after(() => refusing.close());
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: `http://127.0.0.1:${refusing.address().port}/api/v2/alerts` });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /PRs: the alert was refused: HTTP 500/);
    assert.equal(result.state.model, 'minimax/MiniMax-M3.1-Flash');
});
