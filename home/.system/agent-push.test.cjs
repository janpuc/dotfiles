const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const script = join(__dirname, 'agent-push');
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), env = {...process.env};
const git = (...a) => cp.execFileSync('git', ['--git-dir', env.TEST_REMOTE, ...a], {env, encoding:'utf8'}).trim();
if (args[0] === 'repo') { console.log(JSON.stringify({nameWithOwner:'janpuc/test'})); process.exit(); }
const payload = JSON.parse(fs.readFileSync(0,'utf8'));
fs.appendFileSync(env.TEST_CALLS, JSON.stringify({args,payload})+'\\n');
if (args[1] !== 'graphql') {
  git('update-ref', payload.ref, payload.sha); console.log('{}'); process.exit();
}
const input = payload.variables.input;
const ref = 'refs/heads/'+input.branch.branchName;
if (git('rev-parse',ref) !== input.expectedHeadOid) throw Error('expectedHeadOid mismatch');
if (env.TEST_RACE) throw Error('simulated concurrent update');
env.GIT_INDEX_FILE = env.TEST_INDEX;
env.GIT_WORK_TREE = process.cwd();
git('read-tree', input.expectedHeadOid);
for (const {path} of input.fileChanges.deletions) git('update-index','--force-remove','--',path);
for (const {path,contents} of input.fileChanges.additions) {
  const oid = cp.execFileSync('git',['--git-dir',env.TEST_REMOTE,'hash-object','-w','--stdin'],{input:Buffer.from(contents,'base64'),env,encoding:'utf8'}).trim();
  git('update-index','--add','--cacheinfo','100644',oid,path);
}
const tree = git('write-tree');
const oid = git('-c','user.name=App','-c','user.email=app@example.com','commit-tree',tree,'-p',input.expectedHeadOid,'-m',input.message.headline,'-m',input.message.body);
git('update-ref',ref,oid,input.expectedHeadOid);
console.log(JSON.stringify({data:{createCommitOnBranch:{commit:{oid}}}}));
`;
function fixture(t, existing = false) {
    const root = mkdtempSync(join(tmpdir(), 'agent-push-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cwd = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'bin');
    mkdirSync(cwd); mkdirSync(bin);
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_REMOTE: remote,
        TEST_CALLS: join(root, 'calls'), TEST_INDEX: join(root, 'index'),
        GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Test', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'test@example.com' };
    const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    git('init', '--bare', remote); git('init', '-b', 'main');
    writeFileSync(join(cwd, 'original'), 'old\n'); writeFileSync(join(cwd, 'remove'), 'delete me\n');
    git('add', '.'); git('commit', '-m', 'base'); git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
    git('checkout', '-b', 'feature/test');
    if (existing) git('push', 'origin', 'HEAD');
    writeFileSync(join(bin, 'gh'), fakeGh, { mode: 0o755 });
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
    const commit = (subject) => { git('add', '-A'); git('commit', '-m', subject); };
    return { root, cwd, env, git, run, commit, calls: () => readFileSync(env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse) };
}
for (const existing of [false, true]) test(`agent-push: ${existing ? 'existing' : 'new'} remote branch, dry-run then one API commit and reset`, t => {
    const f = fixture(t, existing);
    writeFileSync(join(f.cwd, 'original'), 'new\n'); f.commit('first change');
    const binary = Buffer.from([0, 255, 13, 10, 3]);
    writeFileSync(join(f.cwd, 'binary file'), binary); rmSync(join(f.cwd, 'remove')); f.commit('last change');
    const before = f.git('rev-parse', 'HEAD');
    const dry = f.run('--dry-run'); assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout); assert.equal(plan.dryRun, true);
    assert.equal(Boolean(plan.createBranchAt), !existing);
    assert.match(plan.message.body, /first change\n- last change/);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.notEqual(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'origin/feature/test'));
    assert.equal(f.git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/test');
    assert.equal(f.git('log', '-1', '--format=%s'), 'last change');
    assert.deepEqual(readFileSync(join(f.cwd, 'binary file')), binary);
    const calls = f.calls(); assert.equal(calls.length, existing ? 1 : 2);
    const input = calls.at(-1).payload.variables.input;
    assert.equal(input.fileChanges.additions.find(a => a.path === 'binary file').contents, binary.toString('base64'));
    assert.deepEqual(input.fileChanges.deletions, [{path: 'remove'}]);
    assert.equal(f.git('rev-list', '--count', 'origin/main..HEAD'), '1');
});

test('agent-push: protected branches, dirty tree, unsupported modes and workflows refuse before API writes', t => {
    const f = fixture(t);
    f.git('checkout', 'main'); assert.notEqual(f.run().status, 0);
    f.git('checkout', 'feature/test'); writeFileSync(join(f.cwd, 'original'), 'dirty');
    assert.match(f.run().stderr, /commit or stash/); f.git('checkout', '--', 'original');
    chmodSync(join(f.cwd, 'original'), 0o755); f.git('config', 'core.filemode', 'true'); f.commit('chmod');
    assert.match(f.run().stderr, /mode changes/); f.git('reset', '--hard', 'origin/main');
    require('node:fs').symlinkSync('original', join(f.cwd, 'link')); f.commit('symlink');
    assert.match(f.run().stderr, /symlink/); f.git('reset', '--hard', 'origin/main');
    mkdirSync(join(f.cwd, '.github/workflows'), {recursive:true}); writeFileSync(join(f.cwd, '.github/workflows/test.yml'), 'test'); f.commit('workflow');
    assert.match(f.run().stderr, /workflow writes/);
    assert.equal(require('node:fs').existsSync(f.env.TEST_CALLS), false);
});

test('agent-push: expected-head mutation failure keeps local commits', t => {
    const f = fixture(t, true);
    writeFileSync(join(f.cwd, 'original'), 'new'); f.commit('change');
    const before = f.git('rev-parse', 'HEAD'); f.env.TEST_RACE = '1';
    const result = f.run(); assert.notEqual(result.status, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('agent-push: diverged remote history is refused', t => {
    const f = fixture(t, true);
    writeFileSync(join(f.cwd, 'original'), 'remote change'); f.commit('remote'); f.git('push', 'origin', 'HEAD');
    f.git('reset', '--hard', 'origin/main'); writeFileSync(join(f.cwd, 'original'), 'local'); f.commit('divergent');
    assert.notEqual(f.run().status, 0);
    assert.equal(require('node:fs').existsSync(f.env.TEST_CALLS), false);
});
