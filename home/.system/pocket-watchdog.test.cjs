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
    { provider: 'opencode-go', id: 'deepseek-v4.1-flash' },
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

// One watchdog run over the shipped PRs chain, with the fake servers and an optional state. The
// shipped reset and dispatch are off unless a test passes its own (`session`), and `config` adds
// top-level keys.
async function run(t, { pocketUrl, alertUrl, state, session = {}, config: extra = {}, now, dir: given }) {
    const dir = given ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-watchdog-'));
    if (!given) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tokenFile = path.join(dir, 'pocket.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ ownerToken: TOKEN }), { mode: 0o600 });
    const { reset, dispatch, instructions, ...base } = shipped.sessions.find((each) => each.id === PRS);
    const config = {
        pocket: { baseUrl: pocketUrl, tokenFile, tokenKey: 'ownerToken' },
        alertmanager: { url: alertUrl },
        sessions: [{ ...base, ...session }],
        ...extra,
    };
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const stateFile = path.join(dir, 'state.json');
    if (state) fs.writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: { [PRS]: state } }));
    const args = ['-I', script, '--config', configFile, '--state', stateFile, ...(now ? ['--now', String(now)] : [])];
    const result = await new Promise((resolve) => {
        execFile('python3', args, { encoding: 'utf8' },
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
    assert.deepEqual(shipped.sessions.map((session) => session.id).sort((a, b) => a - b), [548, 1356, 1838, 3120, 7766, 24161]);
    for (const session of shipped.sessions) assert.equal(session.chain.at(-1), 'm3pro/huihui-qwen3.8-27b:off');
});

test('shipped config: the background sessions stay off Claude and Sol, reset, and are dispatched', () => {
    const background = ['Alerts', 'PRs', 'Upstream', 'Home'];
    for (const session of shipped.sessions) {
        if (background.includes(session.name)) {
            assert.deepEqual(session.chain, ['minimax/MiniMax-M3.1-Flash:medium', 'opencode-go/deepseek-v4.1-flash:medium',
                'm3pro/huihui-qwen3.8-27b:off'], session.name);
        } else {
            assert.deepEqual(session.chain, ['anthropic/claude-sonnet-5-5:medium', 'opencode-go/deepseek-v4.1-flash:medium',
                'minimax/MiniMax-M3.1-Flash:medium', 'm3pro/huihui-qwen3.8-27b:off'], session.name);
        }
        assert.ok(!session.chain.some((link) => link.startsWith('openai')), `${session.name} has no OpenAI link`);
        const dispatched = session.name !== 'Trainer';
        assert.equal(Boolean(session.reset), dispatched, `${session.name} reset`);
        assert.equal(Boolean(session.dispatch), dispatched, `${session.name} dispatch`);
        if (dispatched) {
            assert.match(session.stateFile, /^[a-z]+\.md$/);
            assert.equal(session.instructions, `/etc/pocket-watchdog/sessions/${session.stateFile}`);
            const text = fs.readFileSync(path.join(__dirname, 'pi-pocket-sessions', session.stateFile), 'utf8');
            assert.ok(text.length < 8000, `${session.name}: Pi Pocket takes at most 8000 characters`);
            assert.match(text, new RegExp(`~/work/state/${session.stateFile.replace('.', '\\.')}`), `${session.name} names its state file`);
        }
    }
    assert.equal(shipped.resetAboveTokens, 30000);
    assert.equal(shipped.breakerFile, '/var/lib/pocket-usage-report/breaker.json');
});

test('a limit failure moves the session to the next model and tells it once', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'), live: { busy: false },
        entries: [answer(1, now - 3 * HOUR), limitError(2, now - 5 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }]);
    assert.equal(submits(pocket.posts).length, 1);
    assert.match(submits(pocket.posts)[0].body.text, /MiniMax's usage limit ran out\. You now run on deepseek-v4\.1-flash\./);
    assert.equal(result.state.handledFailure, 2);
    assert.equal(result.state.model, 'opencode-go/deepseek-v4.1-flash');
    assert.equal(am.alerts.length, 0);
});

test('the same failure seen again is not a new one: no second switch, and a page after 30 minutes', async (t) => {
    const now = Date.now();
    const view = { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false }, entries: [limitError(2, now - 40 * MINUTE)] };
    const state = (handledAt) => ({ model: 'opencode-go/deepseek-v4.1-flash', fallbackSince: handledAt, handledFailure: 2, handledAt,
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
    const pocket = await fakePocket(t, { view: { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false },
        entries: [limitError(2, now - 2 * HOUR), answer(3, now - HOUR), limitError(4, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'opencode-go/deepseek-v4.1-flash',
        fallbackSince: now - 2 * HOUR, handledFailure: 2, handledAt: now - 2 * HOUR, failures: { 'minimax/MiniMax-M3.1-Flash': now - 2 * HOUR } } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'm3pro', modelId: 'huihui-qwen3.8-27b' }]);
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
    assert.deepEqual(configures(pocket.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }]);
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
    assert.deepEqual(configures(second.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }]);
    assert.equal(am2.alerts.length, 0, 'the run that switched does not page');
    assert.equal(old.state.waitSince, undefined);
});

test('old limit failures do not page once the session runs again', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false }, entries: [answer(6, now - 5 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'opencode-go/deepseek-v4.1-flash', fallbackSince: now - HOUR,
        failures: { 'minimax/MiniMax-M3.1-Flash': now - 3 * HOUR, 'openai/gpt-6.1-sol': now - 2 * HOUR, 'opencode-go/deepseek-v4.1-flash': now - HOUR,
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

    const idle = { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false }, entries: [answer(3, now - 10 * MINUTE)] };
    for (const [reset, back] of [[now + HOUR, false], [now - MINUTE, true]]) {
        const pocket = await fakePocket(t, { view: idle });
        const am = await fakeAlertmanager(t);
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'opencode-go/deepseek-v4.1-flash',
            fallbackSince: now - 2 * HOUR, failures: {}, resets: { minimax: reset } } });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(configures(pocket.posts), back ? [{ provider: 'minimax', modelId: 'MiniMax-M3.1-Flash' }] : []);
        if (back) assert.equal(result.state.resets.minimax, undefined);
    }
});

test('a spent chain pages Jan once, with a plain sentence first', async (t) => {
    const now = Date.now();
    const spent = { 'minimax/MiniMax-M3.1-Flash': now - 3 * HOUR, 'openai/gpt-6.1-sol': now - 2 * HOUR, 'opencode-go/deepseek-v4.1-flash': now - HOUR };
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
    const pocket = await fakePocket(t, { models: METERED, view: { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false },
        entries: [limitError(5, now - 2 * MINUTE)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'opencode-go/deepseek-v4.1-flash',
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
    const pocket = await fakePocket(t, { view: { ...onModel('opencode-go', 'deepseek-v4.1-flash'), live: { busy: false }, entries: [answer(3, now - HOUR)] } });
    const am = await fakeAlertmanager(t);
    const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, state: { model: 'opencode-go/deepseek-v4.1-flash', fallbackSince: now - 13 * HOUR, failures: {} } });
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

// ---------------------------------------------------------------------------------------------
// Fresh contexts and dispatched passes.

const resets = (posts) => posts.filter((post) => post.path.endsWith('/reset'));
const cancels = (posts) => posts.filter((post) => post.path.endsWith('/cancel')).map((post) => post.path);
const big = (tokens) => ({ stats: { contextTokens: tokens } });
// Tuesday 2026-11-10, 08:05 in Warsaw (CET, UTC+1), and the Monday before it at 09:05.
const TUESDAY = Date.UTC(2026, 10, 10, 7, 5);
const MONDAY = Date.UTC(2026, 10, 9, 8, 5);

// The checks' commands, faked: one script answers for pr-lane, upstream-diff and gh from fixture
// files in `dir`, so the watchdog runs them the way it runs the real ones.
function fakeTools(t, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-watchdog-tools-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = path.join(dir, 'fake.cjs');
    fs.writeFileSync(fake, `
const fs = require('node:fs'); const path = require('node:path');
const [dir, tool, ...args] = process.argv.slice(2);
let name = tool;
if (tool === 'upstream-diff') name = args[0] === '--upgrade' ? \`upgrade-\${args[1]}-\${args[2]}\` : 'upstream-diff';
if (tool === 'gh') name = \`body-\${args[1].split('/').at(-1)}\`;
const file = path.join(dir, name);
if (!fs.existsSync(file)) { console.error(\`no fixture \${name}\`); process.exit(3); }
process.stdout.write(fs.readFileSync(file, 'utf8'));
`);
    const write = (more) => { for (const [name, value] of Object.entries(more)) fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)); };
    write(files);
    const cmd = (tool) => [process.execPath, fake, dir, tool];
    return { write, commands: { prLane: cmd('pr-lane'), upstreamDiff: cmd('upstream-diff'), gh: cmd('gh') } };
}

const lanePr = (pr, lane, head, extra = {}) => ({ pr, head, lane, reasons: extra.reasons ?? [], facts: {
    kritika: { state: 'success', reviewedHead: head, confidence: 4, risk: 'low', ...(extra.kritika ?? {}) },
    checks: [{ name: 'flate', status: 'completed', conclusion: extra.ci ?? 'success' }], statuses: [],
    konflate: { head, status: 'ready' } } });

const prsSession = (tools, more = {}) => ({ reset: true, stateFile: 'prs.md',
    dispatch: { gate: 'prs', hours: [8, 18], replaces: 'Run one PR shepherd pass.', ...more } });

test('an idle session on a large context is reset once, with a note that names its state file', async (t) => {
    const now = Date.now();
    const view = { ...onModel('minimax', 'MiniMax-M3.1-Flash'), ...big(150000), live: { busy: false }, entries: [answer(40, now - 2 * HOUR)] };
    const pocket = await fakePocket(t, { view });
    const am = await fakeAlertmanager(t);
    const first = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, session: { reset: true, stateFile: 'prs.md' } });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(resets(pocket.posts).length, 1);
    assert.match(resets(pocket.posts)[0].body.note, /about 150K tokens/);
    assert.match(resets(pocket.posts)[0].body.note, /~\/work\/state\/prs\.md: read it first/);
    assert.equal(first.state.resetEntry, 40);
    assert.equal(submits(pocket.posts).length, 0, 'a reset alone sends no message');

    // The same idle period: no second reset, even when the view still shows the old figure.
    const again = await fakePocket(t, { view });
    const second = await run(t, { pocketUrl: again.url, alertUrl: am.url, session: { reset: true, stateFile: 'prs.md' }, state: first.state });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(again.posts, []);
});

test('no reset while it works, waits for approval, spoke recently, or measured nothing since', async (t) => {
    const now = Date.now();
    const cases = [
        ['working', { meta: { busy: true }, view: { live: { busy: true }, entries: [answer(1, now - 5 * MINUTE)] } }],
        ['approval', { meta: { waiting: true }, view: { live: { busy: false }, entries: [answer(1, now - 2 * HOUR)] } }],
        ['recent', { view: { live: { busy: false }, entries: [answer(1, now - 10 * MINUTE)] } }],
        ['small', { view: { live: { busy: false }, entries: [answer(1, now - 2 * HOUR)], stats: { contextTokens: 25000 } } }],
        ['estimated', { view: { live: { busy: false }, entries: [answer(1, now - 2 * HOUR)], stats: { contextTokens: 90000, contextEstimated: true } } }],
    ];
    for (const [label, { meta, view }] of cases) {
        const pocket = await fakePocket(t, { meta, view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'), ...big(200000), ...view } });
        const am = await fakeAlertmanager(t);
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, session: { reset: true, stateFile: 'prs.md' } });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(resets(pocket.posts).length, 0, label);
    }
    // A session without `reset` (the Trainer) keeps its history.
    const keep = await fakePocket(t, { view: { ...onModel('minimax', 'MiniMax-M3.1-Flash'), ...big(400000), live: { busy: false }, entries: [answer(1, now - 5 * HOUR)] } });
    const am = await fakeAlertmanager(t);
    await run(t, { pocketUrl: keep.url, alertUrl: am.url });
    assert.deepEqual(keep.posts, []);
});

test('a session on a model its chain does not name is moved onto the chain when idle', async (t) => {
    const now = Date.now();
    const pocket = await fakePocket(t, { view: { ...onModel('anthropic', 'claude-sonnet-5-5'), live: { busy: false }, entries: [answer(1, now - HOUR)] } });
    const am = await fakeAlertmanager(t);
    const moved = await run(t, { pocketUrl: pocket.url, alertUrl: am.url });
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(configures(pocket.posts), [{ provider: 'minimax', modelId: 'MiniMax-M3.1-Flash' }]);

    // Past a provider known to be out until later: the next link.
    const out = await fakePocket(t, { view: { ...onModel('anthropic', 'claude-sonnet-5-5'), live: { busy: false }, entries: [answer(1, now - HOUR)] } });
    const later = await run(t, { pocketUrl: out.url, alertUrl: am.url, state: { model: 'anthropic/claude-sonnet-5-5', fallbackSince: now - HOUR,
        failures: {}, resets: { minimax: now + 5 * HOUR } } });
    assert.equal(later.code, 0, later.stderr);
    assert.deepEqual(configures(out.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }]);

    // Past a provider whose limit gate Pi Pocket holds shut, from its limits file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-limits-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const limits = path.join(dir, 'provider-limits.json');
    fs.writeFileSync(limits, JSON.stringify({ gates: [{ state: 'waiting', provider: 'minimax', until: now + 9 * HOUR },
        { state: 'waiting', provider: 'opencode-go', until: now - MINUTE }] }));
    const gated = await fakePocket(t, { view: { ...onModel('anthropic', 'claude-sonnet-5-5'), live: { busy: false }, entries: [answer(1, now - HOUR)] } });
    const past = await run(t, { pocketUrl: gated.url, alertUrl: am.url, config: { limits } });
    assert.equal(past.code, 0, past.stderr);
    assert.deepEqual(configures(gated.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }], 'a gate that has passed does not count');
});

test('PRs: a pass goes out only for PRs that changed, past lane A and the upgrade groups, once per slot', async (t) => {
    const tools = fakeTools(t, { 'pr-lane': [lanePr(12, 'B', 'a'.repeat(40)), lanePr(13, 'A', 'b'.repeat(40)),
        lanePr(14, 'C', 'c'.repeat(40), { reasons: ['talos group named in title'] }), lanePr(15, 'wait', 'd'.repeat(40), { kritika: { state: 'pending' } })] });
    const view = (at) => ({ ...onModel('minimax', 'MiniMax-M3.1-Flash'), ...big(160000), live: { busy: false }, entries: [answer(50, at)],
        schedules: [{ id: 'a83594', text: 'Run one PR shepherd pass.', repeat: 'every day at 18:00' },
            { id: 'r1', text: 'Jan: merge #9 now: https://github.com/janpuc/home-ops/pull/9' }] });
    const am = await fakeAlertmanager(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-watchdog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const go = async (now, state) => {
        const pocket = await fakePocket(t, { view: view(now - 10 * MINUTE) });
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, dir, now, state,
            session: prsSession(tools), config: { commands: tools.commands } });
        assert.equal(result.code, 0, result.stderr);
        return { ...result, posts: pocket.posts };
    };

    const first = await go(TUESDAY);
    assert.deepEqual(cancels(first.posts), ['/api/c/1356/schedules/a83594/cancel'], 'only the replaced schedule is cancelled');
    assert.equal(resets(first.posts).length, 1, 'the pass starts on a fresh context, however recent the last answer');
    assert.ok(first.posts.findIndex((p) => p.path.endsWith('/reset')) < first.posts.findIndex((p) => p.path.endsWith('/submit')));
    const [sent] = submits(first.posts);
    assert.match(sent.body.text, /^\[dispatch\] Run one PR shepherd pass\./);
    assert.match(sent.body.text, /- #12 \(lane B\): new\n- #15 \(lane wait\): new/);
    assert.doesNotMatch(sent.body.text, /#13|#14/);
    assert.match(sent.body.text, /Read ~\/work\/state\/prs\.md first/);

    const same = await go(TUESDAY + 30 * MINUTE, first.state);
    assert.equal(submits(same.posts).length, 0, 'one look per slot');

    const quiet = await go(TUESDAY + 10 * HOUR, same.state);
    assert.equal(submits(quiet.posts).length, 0, 'nothing changed: nothing sent');
    assert.match(quiet.stdout, /PRs: nothing new for its prs pass/);

    tools.write({ 'pr-lane': [lanePr(12, 'B', 'e'.repeat(40)), lanePr(13, 'A', 'f'.repeat(40)),
        lanePr(14, 'C', 'c'.repeat(40), { reasons: ['talos group named in title'] })] });
    const moved = await go(TUESDAY + 24 * HOUR, quiet.state);
    const [next] = submits(moved.posts);
    assert.match(next.body.text, /- #12 \(lane B\): new head eeeeeeeee, kritika's review changed, konflate changed\n- #15: closed or merged/);
    assert.doesNotMatch(next.body.text, /#13/, 'a lane A head moving is the broker\'s');
});

test('a pass waits while the session works, is paused by the breaker, and is sent whole when its check fails', async (t) => {
    const am = await fakeAlertmanager(t);
    const tools = fakeTools(t, { 'pr-lane': [lanePr(12, 'B', 'a'.repeat(40))] });
    const config = { commands: tools.commands };

    const busy = await fakePocket(t, { meta: { busy: true }, view: { live: { busy: true }, entries: [answer(1, TUESDAY - MINUTE)] } });
    const waiting = await run(t, { pocketUrl: busy.url, alertUrl: am.url, now: TUESDAY, session: prsSession(tools), config });
    assert.equal(submits(busy.posts).length, 0);
    assert.equal(waiting.state.dispatch?.slot, undefined, 'the slot stays open for the next run');

    const breaker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-breaker-')), 'breaker.json');
    fs.writeFileSync(breaker, JSON.stringify({ paused: { [PRS]: { until: TUESDAY + HOUR, reason: '16M tokens in 24 h' } } }));
    const idle = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, TUESDAY - HOUR)] } });
    const paused = await run(t, { pocketUrl: idle.url, alertUrl: am.url, now: TUESDAY, session: prsSession(tools), config: { ...config, breakerFile: breaker } });
    assert.equal(submits(idle.posts).length, 0);
    assert.match(paused.stdout, /the prs pass of PRs is paused until tomorrow: 16M tokens in 24 h/);

    const broken = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, TUESDAY - HOUR)] } });
    const whole = await run(t, { pocketUrl: broken.url, alertUrl: am.url, now: TUESDAY, session: prsSession(tools),
        config: { commands: { ...tools.commands, prLane: [process.execPath, '-e', 'process.exit(2)'] } } });
    assert.equal(whole.code, 0, whole.stderr);
    assert.match(submits(broken.posts)[0].body.text, /Run one PR shepherd pass\. pocket-watchdog could not check first \(pr-lane failed with exit 2/);
});

test('Upstream: new non-bot commits, and the Monday digest', async (t) => {
    const am = await fakeAlertmanager(t);
    const tools = fakeTools(t, { 'upstream-diff': { counts: { commits: 2, relevant: 1 }, commits: [
        { sha: '1'.repeat(40), subject: 'feat(talos): bump schematic', relevant: true }, { sha: '2'.repeat(40), subject: 'docs: readme', relevant: false }] } });
    const session = { reset: true, stateFile: 'upstream.md', dispatch: { gate: 'upstream', hours: [9], replaces: 'Run the daily upstream pass.' } };
    const go = async (now, state) => {
        const pocket = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, now - HOUR)] } });
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, now, state, session, config: { commands: tools.commands } });
        assert.equal(result.code, 0, result.stderr);
        return { ...result, sent: submits(pocket.posts).map((p) => p.body.text) };
    };
    const tuesday = TUESDAY + HOUR; // 09:05
    const first = await go(tuesday);
    assert.match(first.sent[0], /2 non-bot commits after the cursor \(1 relevant\), 2 new since the last pass:\n- 111111111 relevant: feat\(talos\)/);
    const next = await go(tuesday + 24 * HOUR, first.state);
    assert.deepEqual(next.sent, [], 'the same commits are not sent twice');

    const monday = await go(MONDAY + 7 * 24 * HOUR, next.state);
    assert.match(monday.sent[0], /no new upstream commits\.\nIt is Monday: post the weekly digest/);
    const later = await go(MONDAY + 7 * 24 * HOUR + 2 * HOUR, { ...monday.state, dispatch: { ...monday.state.dispatch, slot: 'x' } });
    assert.deepEqual(later.sent, [], 'one digest a Monday');
});

test('Upgrades: a Talos PR is sent when it is new and when upstream merges its version', async (t) => {
    const am = await fakeAlertmanager(t);
    const talos = lanePr(20, 'C', '9'.repeat(40), { reasons: ['talos group named in title'] });
    const tools = fakeTools(t, { 'pr-lane': [talos, lanePr(12, 'B', 'a'.repeat(40))],
        'body-20': '| Package | Change |\n|---|---|\n| siderolabs/talos | `v1.14.2` → `v1.14.5` |\n',
        'upgrade-talos-1.14.5': { merged: false, upstream: null } });
    const session = { reset: true, stateFile: 'upgrades.md', dispatch: { gate: 'upgrades', hours: [9, 15], replaces: 'Run the daily upgrades pass.' } };
    const go = async (now, state) => {
        const pocket = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, now - HOUR)] } });
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, now, state, session, config: { commands: tools.commands } });
        assert.equal(result.code, 0, result.stderr);
        return { ...result, sent: submits(pocket.posts).map((p) => p.body.text) };
    };
    const first = await go(TUESDAY + HOUR);
    assert.match(first.sent[0], /These Talos and Kubernetes PRs changed since the last pass:\n- #20 \(lane C\): new$/m);
    assert.doesNotMatch(first.sent[0], /#12/);
    const held = await go(TUESDAY + 7 * HOUR, first.state);
    assert.deepEqual(held.sent, []);
    tools.write({ 'upgrade-talos-1.14.5': { merged: true, upstream: { sha: 'u'.repeat(40) } } });
    const merged = await go(TUESDAY + 25 * HOUR, held.state);
    assert.match(merged.sent[0], /- #20 \(lane C\): upstream changed/);
});

test('Home: the drift check goes out when Home Assistant\'s automations or scripts change', async (t) => {
    const am = await fakeAlertmanager(t);
    const configs = { 'automation/config/1700000000001': { id: '1700000000001', alias: 'Door', description: '' }, 'script/config/night': { alias: 'Night' } };
    const seen = [];
    const ha = await listen((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization, agent: req.headers['user-agent'] });
        const reply = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.url === '/api/states') return reply([{ entity_id: 'automation.door', attributes: { id: '1700000000001' } },
            { entity_id: 'script.night', attributes: {} }, { entity_id: 'script.made_by_an_integration', attributes: {} },
            { entity_id: 'light.office', attributes: {} }]);
        const key = req.url.replace('/api/config/', '');
        if (configs[key]) return reply(configs[key]);
        res.writeHead(404); res.end('{}');
    });
    t.after(() => ha.close());
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ha-'));
    t.after(() => fs.rmSync(envDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(envDir, 'secrets.env'), 'MINIMAX_API_KEY=x\nHA_TOKEN=ha-token-that-must-never-be-printed\n');
    const config = { homeAssistant: { url: `http://127.0.0.1:${ha.address().port}`, envFile: path.join(envDir, 'secrets.env'), tokenKey: 'HA_TOKEN' } };
    const session = { reset: true, stateFile: 'home.md', dispatch: { gate: 'home', hours: [12], replaces: 'Run the Home Assistant drift check.', atLeastEveryDays: 7 } };
    const noon = TUESDAY + 4 * HOUR;
    const go = async (now, state) => {
        const pocket = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, now - HOUR)] } });
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, now, state, session, config });
        assert.equal(result.code, 0, result.stderr);
        assert.ok(!`${result.stdout}${result.stderr}`.includes('ha-token-that-must-never-be-printed'));
        return { ...result, sent: submits(pocket.posts).map((p) => p.body.text) };
    };
    const first = await go(noon);
    assert.match(first.sent[0], /Run the Home Assistant drift check\.\nIt is the first check/);
    assert.ok(seen.every((r) => r.auth === 'Bearer ha-token-that-must-never-be-printed' && !/Python/.test(r.agent)));
    const quiet = await go(noon + 24 * HOUR, first.state);
    assert.deepEqual(quiet.sent, []);
    configs['automation/config/1700000000001'].description = 'edited in the UI';
    const moved = await go(noon + 48 * HOUR, quiet.state);
    assert.match(moved.sent[0], /changed since the last check: automation\.door\./);
    delete configs['automation/config/1700000000001'].description;
    configs['automation/config/1700000000001'].description = 'edited in the UI';
    const weekly = await go(noon + 10 * 24 * HOUR, moved.state);
    assert.match(weekly.sent[0], /Nothing moved, but the last check was over 7 days ago/);
});

test('Alerts: the daily scan goes out for Prometheus findings it was not told about this week', async (t) => {
    const am = await fakeAlertmanager(t);
    const answers = { 'PVC over 85% full': [{ metric: { namespace: 'media', persistentvolumeclaim: 'plex' }, value: [0, '0.9'] }] };
    const prom = await listen((req, res) => {
        const query = new URL(req.url, 'http://x').searchParams.get('query');
        const name = query.startsWith('pvc') ? 'PVC over 85% full' : query.startsWith('pods') ? 'Pod waiting' : null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', data: { result: answers[name] ?? [] } }));
    });
    t.after(() => prom.close());
    const checks = [{ name: 'PVC over 85% full', query: 'pvc' }, { name: 'Pod waiting', query: 'pods' }];
    const session = { reset: true, stateFile: 'alerts.md', dispatch: { gate: 'cluster', hours: [7], replaces: 'Run the daily cluster scan.', checks } };
    const config = { prometheus: `http://127.0.0.1:${prom.address().port}` };
    const go = async (now, state) => {
        const pocket = await fakePocket(t, { view: { live: { busy: false }, entries: [answer(1, now - HOUR)] } });
        const result = await run(t, { pocketUrl: pocket.url, alertUrl: am.url, now, state, session, config });
        assert.equal(result.code, 0, result.stderr);
        return { ...result, sent: submits(pocket.posts).map((p) => p.body.text) };
    };
    const first = await go(TUESDAY);
    assert.match(first.sent[0], /Run the daily cluster scan\. .*new since the last scan:\n- PVC over 85% full namespace=media, persistentvolumeclaim=plex\n/s);
    const quiet = await go(TUESDAY + 24 * HOUR, first.state);
    assert.deepEqual(quiet.sent, [], 'a finding already reported is not sent again within a week');
    answers['Pod waiting'] = [{ metric: { namespace: 'ai', pod: 'litellm-0', reason: 'CrashLoopBackOff', instance: 'x' }, value: [0, '1'] }];
    const crash = await go(TUESDAY + 48 * HOUR, quiet.state);
    assert.match(crash.sent[0], /- Pod waiting namespace=ai, pod=litellm-0, reason=CrashLoopBackOff\nStill there, already reported: PVC over 85% full/);
    const week = await go(TUESDAY + 9 * 24 * HOUR, crash.state);
    assert.match(week.sent[0], /- PVC over 85% full/, 'told again after a week');
});

test('instructions: set from the file once each time it changes, and an edit in the app then stands', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-instructions-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'prs.md');
    fs.writeFileSync(file, 'Shepherd the PRs.\n');
    const am = await fakeAlertmanager(t);
    const view = (instructions) => ({ agent: { model: { provider: 'minimax', modelId: 'MiniMax-M3.1-Flash' }, instructions },
        live: { busy: false }, entries: [answer(1, Date.now() - HOUR)] });
    const set = (posts) => posts.filter((p) => p.path.endsWith('/instructions')).map((p) => p.body.text);

    const old = await fakePocket(t, { view: view('Old text.') });
    const first = await run(t, { pocketUrl: old.url, alertUrl: am.url, session: { instructions: file } });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(set(old.posts), ['Shepherd the PRs.']);

    const edited = await fakePocket(t, { view: view('Jan edited this in the app.') });
    const second = await run(t, { pocketUrl: edited.url, alertUrl: am.url, session: { instructions: file }, state: first.state });
    assert.deepEqual(set(edited.posts), [], 'the file did not change');

    fs.writeFileSync(file, 'Shepherd the PRs, briefly.\n');
    const changed = await fakePocket(t, { view: view('Jan edited this in the app.') });
    await run(t, { pocketUrl: changed.url, alertUrl: am.url, session: { instructions: file }, state: second.state });
    assert.deepEqual(set(changed.posts), ['Shepherd the PRs, briefly.']);
});

test('a backoff wait has no known reset: its next try is not a reset, so it moves on after 30 minutes', async (t) => {
    const now = Date.now();
    const view = { ...onModel('minimax', 'MiniMax-M3.1-Flash'), entries: [answer(1, now - 2 * MINUTE)],
        live: { busy: true, limit: { provider: 'minimax', kind: 'backoff', until: now + 10 * MINUTE, reason: "minimax's usage limit" } } };
    const am = await fakeAlertmanager(t);
    const fresh = await fakePocket(t, { meta: { busy: true }, view });
    const first = await run(t, { pocketUrl: fresh.url, alertUrl: am.url });
    assert.deepEqual(fresh.posts, [], 'not yet: the wait has just begun');
    const old = await fakePocket(t, { meta: { busy: true }, view });
    await run(t, { pocketUrl: old.url, alertUrl: am.url, state: { ...first.state, waitSince: now - 40 * MINUTE } });
    assert.deepEqual(configures(old.posts), [{ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }]);
});
