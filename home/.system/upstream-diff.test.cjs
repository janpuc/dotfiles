// Run with Node >=22.19: node --test home/.system/upstream-diff.test.cjs
// The upstream is a local fake repository; nothing here touches the network or a real home.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const script = join(__dirname, 'upstream-diff');

const DAY = 24 * 60 * 60 * 1000;
// A fixed clock keeps the 14-day window and the companion window deterministic.
function iso(daysAgo, hours = 0) {
    return new Date(Date.now() - daysAgo * DAY + hours * 3600000).toISOString();
}

function git(cwd, args, env = {}) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
    }).trim();
}

function write(root, path, body = 'x\n') {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
}

// One commit in the fake upstream: the files it changes, its author and the day it landed.
function upstreamCommit(repo, { subject, author, email, date, files }) {
    for (const [path, body] of Object.entries(files)) write(repo, path, body);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', subject], {
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date,
    });
    return git(repo, ['rev-parse', 'HEAD']);
}

const CONFIG = [
    'structural_paths:',
    '  - talos/',
    '  - .github/',
    '  - .mise',
    'structural_files:',
    '  - mod.just',
    'ignored_apps:',
    '  - home-assistant',
    'ignored_paths:',
    '  - kubernetes/apps/kube-system/intel-gpu-resource-driver/',
    '',
].join('\n');

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'upstream-diff-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const upstream = join(root, 'upstream');
    const jan = join(root, 'home-ops');
    const config = join(root, 'upstream-sync.yaml');
    mkdirSync(upstream); mkdirSync(jan);
    git(upstream, ['init', '-b', 'main']);
    git(jan, ['init', '-b', 'main']);

    // The upstream: an old commit, a workflow change, a companion of the Talos merge, the
    // Talos upgrade, a bot commit and two app changes. They are made in date order, so the
    // branch reads like a real one.
    upstreamCommit(upstream, {
        subject: 'feat(old): a commit outside the window (#11000)',
        author: 'Devin Buhl', email: 'devin@example.com', date: iso(40),
        files: { 'kubernetes/apps/default/shared/app/helmrelease.yaml': 'old\n' },
    });
    const workflow = upstreamCommit(upstream, {
        subject: 'ci: pin talosctl to the cluster version (#11882)',
        author: 'Devin Buhl', email: 'devin@example.com', date: iso(4),
        files: { '.github/workflows/ci.yaml': 'name: ci\n' },
    });
    const companion = upstreamCommit(upstream, {
        subject: 'chore(talos): a companion change near the merge (#11885)',
        author: 'Devin Buhl', email: 'devin@example.com', date: iso(4),
        files: { 'talos/mod.just': 'default:\n' },
    });
    const talos = upstreamCommit(upstream, {
        subject: 'fix(container): update image siderolabs/talos (v1.14.2 ➔ v1.14.5) (#11873)',
        author: 'renovate[bot]', email: 'renovate[bot]@users.noreply.github.com', date: iso(3),
        files: { 'talos/cluster.yaml.j2': 'talos: v1.14.5\n', 'kubernetes/apps/system-upgrade/tuppr/upgrades/talosupgrade.yaml': 'version: v1.14.5\n' },
    });
    upstreamCommit(upstream, {
        subject: 'fix(container): update image ghcr.io/example/thing (1.0.0 ➔ 1.0.1) (#11874)',
        author: 'renovate[bot]', email: 'renovate[bot]@users.noreply.github.com', date: iso(3),
        files: { 'kubernetes/apps/default/shared/app/helmrelease.yaml': 'bot\n' },
    });
    const shared = upstreamCommit(upstream, {
        subject: 'feat(shared): change the shared app (#12001)',
        author: 'Devin Buhl', email: 'devin@example.com', date: iso(2),
        files: { 'kubernetes/apps/default/shared/app/helmrelease.yaml': 'shared\n' },
    });
    const upstreamOnly = upstreamCommit(upstream, {
        subject: 'feat(only-upstream): an app Jan does not run (#12002)',
        author: 'Devin Buhl', email: 'devin@example.com', date: iso(2),
        files: { 'kubernetes/apps/default/only-upstream/app/helmrelease.yaml': 'nope\n' },
    });

    // Jan's repo: the same app under another namespace, and no upstream-only app.
    write(jan, 'kubernetes/apps/media/shared/app/helmrelease.yaml', 'shared\n');
    write(jan, 'talos/cluster.yaml.j2', 'talos: v1.14.2\n');
    write(jan, '.github/workflows/ci.yaml', 'name: ci\n');
    write(jan, '.mise/config.toml', '[tools]\n');
    write(jan, 'kubernetes/apps/default/home-assistant/app/helmrelease.yaml', 'ha\n');
    git(jan, ['add', '-A']);
    git(jan, ['commit', '-m', 'base']);
    writeFileSync(config, CONFIG);

    const state = join(root, 'state', 'last-sha');
    const run = (...args) => spawnSync(process.execPath, [script, '--repo', jan, '--upstream', upstream,
        '--config', config, '--state', state, ...args], { encoding: 'utf8' });
    const json = (...args) => {
        const result = run(...args, '--json');
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    return { root, upstream, jan, config, state, run, json, shas: { talos, shared, upstreamOnly, workflow, companion } };
}

test('upstream-diff lists non-bot commits, maps them to Jan\'s paths and flags relevance', t => {
    const f = fixture(t);
    const result = f.json();
    assert.equal(result.upstream.url, f.upstream);
    assert.equal(result.cursor.sha, null);
    assert.equal(result.cursor.days, 14);
    const subjects = result.commits.map((commit) => commit.subject);
    assert.ok(!subjects.some((subject) => subject.includes('ghcr.io/example/thing')), 'bot commits are skipped');
    assert.ok(!subjects.some((subject) => subject.includes('a commit outside the window')));
    assert.ok(subjects.includes('feat(shared): change the shared app (#12001)'));

    const shared = result.commits.find((commit) => commit.subject.includes('feat(shared)'));
    assert.equal(shared.relevant, true);
    assert.equal(shared.pr, 12001);
    assert.equal(shared.files.length, 1);
    assert.equal(shared.files[0].path, 'kubernetes/apps/default/shared/app/helmrelease.yaml');
    assert.equal(shared.files[0].janPath, 'kubernetes/apps/media/shared/app/helmrelease.yaml');
    assert.equal(shared.files[0].exists, true);

    const only = result.commits.find((commit) => commit.subject.includes('only-upstream'));
    assert.equal(only.relevant, false);
    assert.equal(only.files[0].janPath, 'kubernetes/apps/default/only-upstream/app/helmrelease.yaml');
    assert.equal(only.files[0].exists, false);

    const workflow = result.commits.find((commit) => commit.subject.includes('pin talosctl'));
    assert.equal(workflow.relevant, true);
    assert.equal(workflow.files[0].janPath, '.github/workflows/ci.yaml');
    assert.equal(result.counts.commits, result.commits.length);
    assert.equal(result.counts.relevant + result.counts.irrelevant, result.counts.commits);
});

test('upstream-diff keeps the cursor, only moves it forward and refuses a sha off upstream/main', t => {
    const f = fixture(t);
    const first = f.json();
    assert.equal(first.commits.length > 0, true);
    const marked = f.run('--mark', f.shas.shared);
    assert.equal(marked.status, 0, marked.stderr);
    assert.equal(readFileSync(f.state, 'utf8').trim(), f.shas.shared);
    const after = f.json();
    assert.equal(after.cursor.sha, f.shas.shared);
    assert.ok(!after.commits.some((commit) => commit.sha === f.shas.shared), 'the marked commit is behind the cursor');
    // The companion and the workflow commit are older, so they are gone too.
    assert.ok(!after.commits.some((commit) => commit.subject.includes('pin talosctl')));
    // A sha that is not on upstream/main is refused, and so is a backwards move.
    const foreign = f.run('--mark', 'f'.repeat(40));
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /not a commit/);
    const backwards = f.run('--mark', f.shas.talos);
    assert.notEqual(backwards.status, 0);
    assert.match(backwards.stderr, /only moves forward/);
    assert.equal(readFileSync(f.state, 'utf8').trim(), f.shas.shared);
});

test('upstream-diff --upgrade reports the upstream merge and its companion candidates', t => {
    const f = fixture(t);
    const result = f.json('--upgrade', 'talos', '1.14.5');
    assert.equal(result.merged, true);
    assert.equal(result.upstream.sha, f.shas.talos);
    assert.equal(result.upstream.pr, 11873);
    assert.equal(result.upstream.date, iso(3).slice(0, 10));
    assert.ok(result.upstream.files.some((file) => file.path === 'talos/cluster.yaml.j2'));
    assert.ok(result.companions.some((commit) => commit.sha === f.shas.companion));
    assert.ok(!result.companions.some((commit) => commit.author.includes('renovate')), 'bot commits are not companions');

    const missing = f.json('--upgrade', 'talos', '1.14.9');
    assert.equal(missing.merged, false);
    assert.equal(missing.upstream, null);
    assert.deepEqual(missing.companions, []);
});

test('upstream-diff refuses a mapping file it does not understand', t => {
    const f = fixture(t);
    const bad = join(f.root, 'bad.yaml');
    writeFileSync(bad, 'structural_path:\n  - talos/\n');
    const result = spawnSync(process.execPath, [script, '--repo', f.jan, '--upstream', f.upstream,
        '--config', bad, '--state', f.state], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown key/);
});
