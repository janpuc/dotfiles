const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('./pr-lane');
const head = 'a'.repeat(40);
function fixture() {
    return { pr: {number: 42, head:{sha:head}, state:'open', title:'update image', draft:false,
        user:{login:'bot-atlas[bot]'}, labels:[{name:'type/patch'}], created_at:'2026-01-01T00:00:00Z'},
        files:['kubernetes/apps/downloads/app/helmrelease.yaml'],
        statuses:[{context:'Kritika / Review', state:'success', description:'kritika: confidence 4/5, no findings'}],
        checks:[{name:'Image Pull - Success', status:'completed', conclusion:'skipped'}],
        comments:[{user:{login:'bot-atlas[bot]'}, updated_at:'2026-01-01', body:
            `<!-- kritika:pr-42 -->\n**No findings**\n**Confidence 4/5** · low risk: routine\nLast reviewed commit: [change](https://github.com/janpuc/home-ops/commit/${head})`}],
        entry:{number:42,headSha:head,status:'ready', signals:{resources:1,caution:0,blocking:0,images:1,failures:0,routine:true}},
        rendered:{status:'ready',pr:{headSha:head},diff:{headSha:head,impact:{resources:1,parents:1,crds:0,namespaces:['downloads']},warnings:null}} };
}
function check(mutate, lane, reason) {
    const f = fixture(); mutate(f); const result = classify(f);
    assert.equal(result.lane, lane, JSON.stringify(result));
    if (reason) assert.ok(result.reasons.some(r => r.includes(reason)), JSON.stringify(result.reasons));
}
test('pr-lane: routine digest/patch is A, other eligible PRs B; SKIPPED/NEUTRAL fine', () => {
    check(() => {}, 'A');
    check(f => f.pr.labels = [{name:'type/digest'}], 'A');
    check(f => f.pr.labels = [{name:'type/minor'}], 'B', 'not all A');
    check(f => f.entry.signals.caution = 1, 'B');
    check(f => f.entry.signals.routine = false, 'B');
    check(f => f.comments[0].body = f.comments[0].body.replace('low risk', 'medium risk'), 'B');
    check(f => { f.statuses[0].description = 'kritika: confidence 3/5, no findings'; f.comments[0].body = f.comments[0].body.replace('4/5', '3/5'); }, 'B');
    check(f => f.checks[0].conclusion = 'neutral', 'A');
});
test('pr-lane: all wait gates, stale head/comment and unknown evidence fail closed', () => {
    const cases = [
        [f => f.pr.draft = true, 'draft'],
        [f => f.checks[0].status = 'queued', 'pending'],
        [f => f.statuses.push({context:'other',state:'pending'}), 'pending'],
        [f => f.statuses = [], 'kritika missing'],
        [f => f.statuses[0].state = 'pending', 'kritika pending'],
        [f => f.entry = undefined, 'konflate missing'],
        [f => f.entry.status = 'rendering', 'not ready'],
        [f => f.entry.headSha = 'b'.repeat(40), 'stale'],
        [f => f.rendered.diff.headSha = 'b'.repeat(40), 'stale'],
        [f => f.comments = [], 'comment missing'],
        [f => f.comments[0].user.login = 'janpuc', 'comment missing'],
        [f => f.comments[0].body = f.comments[0].body.replace(head, 'b'.repeat(40)), 'stale'],
        [f => f.comments[0].body = f.comments[0].body.replace('low risk', 'unknown risk'), 'unparseable'],
        [f => f.comments[0].body = f.comments[0].body.replace('**No findings**', 'unstructured'), 'unparseable'],
        [f => f.comments[0].body = f.comments[0].body.replace('4/5', '5/5'), 'unparseable'],
        [f => delete f.entry.signals.blocking, 'schema incomplete'],
        [f => f.rendered.diff.impact.namespaces = null, 'schema incomplete'],
        [f => f.errors = ['GitHub evidence unavailable'], 'unavailable'],
    ];
    for (const [mutate, reason] of cases) check(mutate, 'wait', reason);
});
test('pr-lane: every C rule, including failures and all protected namespaces', () => {
    const cases = [
        [f => f.pr.user.login = 'janpuc-agent[bot]', 'author'],
        [f => f.pr.user.login = 'janpuc', 'author'],
        [f => f.pr.title = 'update talos group', 'talos group'],
        [f => f.pr.labels.push({name:'group/kubernetes'}), 'kubernetes group'],
        [f => f.rendered.diff.impact.crds = 1, 'crds'],
        [f => f.entry.signals.blocking = 1, 'blocking'],
        [f => f.entry.signals.failures = 1, 'failures'],
        [f => { f.statuses[0].state = 'error'; f.comments = []; }, 'review incomplete'],
        [f => f.statuses[0].state = 'failure', 'not success'],
        [f => f.comments[0].body = f.comments[0].body.replace('low risk', 'high risk'), 'high risk'],
        [f => f.comments[0].body = f.comments[0].body.replace('**No findings**', '**2 findings** · 1 P1 · 1 P2'), 'P1'],
        [f => { f.statuses[0].description = 'kritika: confidence 2/5, no findings'; f.comments[0].body = f.comments[0].body.replace('4/5','2/5'); }, 'confidence < 3'],
        [f => f.files = ['kubernetes/apps/ai/litellm-operator/release.yaml'], 'litellm'],
        [f => { f.pr.labels = [{name:'type/major'}]; f.files = ['.mise.toml']; }, 'major Renovate or mise'],
        [f => { f.pr.labels = [{name:'type/major'}]; f.files = ['.renovaterc.json5']; }, 'major Renovate or mise'],
        [f => f.checks[0].conclusion = 'failure', 'failed check'],
        [f => f.checks[0].conclusion = 'cancelled', 'failed check'],
        [f => f.checks[0].conclusion = 'timed_out', 'failed check'],
        [f => f.checks[0].conclusion = 'action_required', 'failed check'],
        [f => f.statuses.push({context:'other',state:'error'}), 'failed status'],
    ];
    for (const prefix of ['talos/','bootstrap/','.github/','kubernetes/flux/','kubernetes/components/'])
        cases.push([f => f.files = [prefix + 'file'], 'protected path']);
    for (const ns of ['kube-system','flux-system','network','security','cnpg-system','miroir-system','kopiur-system','external-secrets','cert-manager']) {
        cases.push([f => f.files = [`kubernetes/apps/${ns}/app/release.yaml`], 'protected namespace path']);
        cases.push([f => f.rendered.diff.impact.namespaces = [ns], 'protected impact namespace']);
    }
    for (const [mutate, reason] of cases) check(mutate, 'C', reason);
});
test('pr-lane: wait precedes C but reasons name every fired rule', () => {
    const f = fixture(); f.pr.draft = true; f.pr.title = 'update talos group';
    f.pr.user.login = 'janpuc'; f.entry.signals.blocking = 1;
    const r = classify(f); assert.equal(r.lane,'wait');
    for (const reason of ['draft', 'talos group', 'author', 'blocking']) assert.ok(r.reasons.some(r => r.includes(reason)));
});

test('pr-lane: zero-resource explicit null namespaces normalized, never missing/null nonzero', () => {
    const f = fixture(); f.rendered.diff.impact = {resources:0,parents:0,crds:0,namespaces:null};
    const result = classify(f); assert.equal(result.lane,'A');
    assert.deepEqual(result.facts.konflate.impact.namespaces,[]);
    assert.equal(result.facts.konflate.namespacesNormalizedFromNull,true);
    assert.ok(result.reasons.includes('konflate zero-resource namespaces:null treated as empty'));
    delete f.rendered.diff.impact.namespaces; assert.equal(classify(f).lane,'wait');
    f.rendered.diff.impact.namespaces=null; f.rendered.diff.impact.resources=1; assert.equal(classify(f).lane,'wait');
});
test('pr-lane: major root .mise directory changes are C and closed PRs wait', () => {
    check(f => { f.files=['.mise/config.toml','.mise/mise.lock']; f.pr.labels=[{name:'type/major'}]; },'C','major Renovate or mise');
    check(f => f.pr.state='closed','wait','not open');
});

test('pr-lane: multiline severity counts are complete evidence, never an implicit zero P1', () => {
    for (const summary of ['**1 finding**\n· 1 P1', '**2 findings**\n· 1 P1 · 1 P2',
        '**2 findings** · 1 P1\n· 1 P2']) {
        check(f => f.comments[0].body = f.comments[0].body.replace('**No findings**', summary), 'C', 'P1 finding');
    }
    check(f => f.comments[0].body = f.comments[0].body.replace('**No findings**', '**2 findings**\n· 2 P2'), 'A');
});
test('pr-lane: absent, malformed, duplicate and inconsistent severity counts wait with unknown P1', () => {
    for (const summary of ['**1 finding** · summary unavailable', '**1 finding**',
        '**2 findings** · 1 P2', '**1 finding** · 2 P2', '**1 finding** · one P1',
        '**2 findings** · 1 P2 · 1 P2', '**2 findings** · 1 P2 · unknown P1']) {
        const f = fixture();
        f.comments[0].body = f.comments[0].body.replace('**No findings**', summary);
        const result = classify(f);
        assert.equal(result.lane, 'wait', summary);
        assert.equal(result.facts.kritika.p1, null, summary);
        assert.ok(result.reasons.some(r => r.includes('severity counts')), JSON.stringify(result.reasons));
        f.statuses[0].state = 'error';
        assert.equal(classify(f).lane, 'wait', 'positive findings with unknown counts always wait');
    }
});

test('pr-lane CLI: paginated GitHub reads, konflate CSS stripped, old rename paths and moved heads', t => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pr-lane-cli-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const f=fixture(); f.pr.changed_files=1;
    fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify(f));
    fs.writeFileSync(path.join(dir,'preload.cjs'), `const f=require(process.env.FIXTURE); global.fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/prs')?[f.entry]:f.rendered});`);
    fs.writeFileSync(path.join(dir,'gh'), `#!/usr/bin/env node
const fs=require('node:fs'), f=require(process.env.FIXTURE), args=process.argv.slice(2), p=args[1];
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
let value;
if(p.includes('/files?')) value=[{filename:f.files[0],...(process.env.RENAME ? {previous_filename:'talos/old.yaml'} : {})}];
else if(p.includes('/status?')) value={statuses:f.statuses};
else if(p.includes('/check-runs?')) value={check_runs:f.checks};
else if(p.includes('/comments?')) value=f.comments;
else if(p.includes('/pulls?')) value=[f.pr];
else value={...f.pr, ...(process.env.MOVED ? {head:{sha:'b'.repeat(40)}} : {}), ...(process.env.INCOMPLETE ? {changed_files:2} : {})};
console.log(JSON.stringify(args.includes('--slurp')?[value]:value));
`, {mode:0o755});
    const env={...process.env,PATH:dir+':'+process.env.PATH,FIXTURE:path.join(dir,'fixture.json'),CALLS:path.join(dir,'calls')};
    const run=()=> {const r=cp.spawnSync(process.execPath,['--require',path.join(dir,'preload.cjs'),path.join(__dirname,'pr-lane'),'--all','--json'],{env,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout)[0];};
    f.rendered.diff.chromaCss='huge css'; fs.writeFileSync(env.FIXTURE,JSON.stringify(f));
    assert.equal(run().lane,'A'); assert.ok(!JSON.stringify(run()).includes('huge css'));
    const calls=fs.readFileSync(env.CALLS,'utf8').trim().split('\n').map(JSON.parse);
    for(const call of calls.filter(c=>c[1].includes('?'))) { assert.ok(call.includes('--paginate')); assert.ok(call.includes('--slurp')); }
    env.RENAME='1'; assert.equal(run().lane,'C'); delete env.RENAME;
    env.MOVED='1'; assert.equal(run().lane,'wait'); delete env.MOVED;
    env.INCOMPLETE='1'; assert.equal(run().lane,'wait');
});
