const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, parseUpdateType } = require('./pr-lane');
const head = 'a'.repeat(40);
// A real Renovate update table: the body is bot-authored and edit-checked, so it
// is the only trusted source for the update type.
function renovateBody(rows) {
    return ['This PR contains the following updates:', '',
        '| Package | Type | Update | Change |', '|---|---|---|---|',
        ...rows.map(row => `| ${row.package} |  | ${row.type} | \`1.0.0\` → \`1.0.1\` |`), ''].join('\n');
}
function fixture() {
    return { pr: {number: 42, node_id:'PR_test', body:renovateBody([{package:'ghcr.io/example/app', type:'patch'}]), base:{ref:'main',repo:{full_name:'janpuc/home-ops'}}, head:{sha:head, ref:'renovate/example'}, state:'open', title:'update image', draft:false,
        user:{login:'bot-atlas[bot]'}, labels:[{name:'type/patch'}], created_at:'2026-01-01T00:00:00Z'},
        files:['kubernetes/apps/downloads/app/helmrelease.yaml'],
        statuses:[{context:'Kritika / Review', state:'success', description:'kritika: confidence 4/5, no findings'}],
        checks:[{name:'Image Pull - Success', status:'completed', conclusion:'skipped'}],
        comments:[{node_id:'IC_test',user:{login:'bot-atlas[bot]'}, updated_at:'2026-01-01', body:
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
    check(f => f.pr.body = renovateBody([{package:'ghcr.io/example/app', type:'digest'}]), 'A');
    check(f => f.pr.body = renovateBody([{package:'ghcr.io/example/app', type:'minor'}]), 'B', 'not all A');
    // A label never qualifies or disqualifies a lane; only the body table does.
    check(f => f.pr.labels = [{name:'type/minor'}], 'A');
    check(f => f.pr.labels = [{name:'type/major'}], 'C', 'type/major label');
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
        [f => { f.pr.body = renovateBody([{package:'x', type:'major'}]); f.files = ['.mise.toml']; }, 'major Renovate or mise'],
        [f => { f.pr.body = renovateBody([{package:'x', type:'major'}]); f.files = ['.renovaterc.json5']; }, 'major Renovate or mise'],
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
    check(f => { f.files=['.mise/config.toml','.mise/mise.lock']; f.pr.body=renovateBody([{package:'x', type:'major'}]); },'C','major Renovate or mise');
    check(f => f.pr.state='closed','wait','not open');
});

test('pr-lane: the body update table, not the label, decides the update type', () => {
    // A renamed label leaves the attachment actors unchanged, so only the body
    // table can keep a major update out of the mergeable lanes.
    check(f => { f.pr.labels = [{name:'type/renamed-major'}]; f.pr.body = renovateBody([{package:'x', type:'major'}]); }, 'B', 'not all A');
    check(f => { f.pr.labels = [{name:'type/renamed-major'}]; f.pr.body = renovateBody([{package:'x', type:'major'}]); f.files = ['.mise/config.toml']; }, 'C', 'major Renovate or mise');
    // A body table saying major while the labels say patch is never A.
    check(f => { f.pr.body = renovateBody([{package:'x', type:'major'}]); f.pr.labels = [{name:'type/patch'}]; }, 'B', 'not all A');
    check(f => { f.pr.body = renovateBody([{package:'x', type:'major'}]); f.pr.labels = [{name:'type/patch'}]; f.files = ['.renovaterc.json5']; }, 'C', 'major Renovate or mise');
    // Grouped rows take the most severe type.
    check(f => { f.pr.body = renovateBody([{package:'a', type:'patch'}, {package:'b', type:'digest'}]); }, 'A');
    check(f => { f.pr.body = renovateBody([{package:'a', type:'patch'}, {package:'b', type:'minor'}]); }, 'B', 'not all A');
    check(f => { f.pr.body = renovateBody([{package:'a', type:'digest'}, {package:'b', type:'major'}]); f.files = ['.mise/config.toml']; }, 'C', 'major Renovate or mise');
});
test('pr-lane: an unparseable or missing update table waits', () => {
    check(f => { f.pr.body = 'This PR contains the following updates:\n\n| Package | Change |\n|---|---|\n| foo | `1.0.0` → `1.0.1` |\n'; }, 'wait', 'update type not derivable');
    check(f => { f.pr.body = 'no table at all'; }, 'wait', 'update type not derivable');
    check(f => { f.pr.body = ''; }, 'wait', 'update type not derivable');
    check(f => { f.pr.body = renovateBody([{package:'x', type:'sideways'}]); }, 'wait', 'update type not derivable');
    check(f => { f.pr.body = renovateBody([{package:'x', type:'patch'}]).replace('|---|---|---|---|', '|---|---|---|'); }, 'wait', 'update type not derivable');
});
test('pr-lane: talos and kubernetes groups are named in the branch and the body table', () => {
    check(f => { f.pr.title = 'chore: update stuff'; f.pr.labels = []; f.pr.head.ref = 'renovate/talos'; }, 'C', 'talos group');
    check(f => { f.pr.title = 'chore: update stuff'; f.pr.labels = []; f.pr.head.ref = 'renovate/kubernetes'; }, 'C', 'kubernetes group');
    check(f => { f.pr.title = 'chore: update stuff'; f.pr.labels = []; f.pr.body = renovateBody([{package:'siderolabs/talos', type:'patch'}]); }, 'C', 'talos group');
    // Release notes that merely mention Kubernetes are not a group PR.
    check(f => { f.pr.title = 'chore: update stuff'; f.pr.labels = [];
        f.pr.body = renovateBody([{package:'[kubectl](https://redirect.github.com/kubernetes/kubernetes)', type:'patch'}]) + 'Kubernetes 1.37 release notes\n'; }, 'A');
});
test('pr-lane: the update table parser is strict and severity ordered', () => {
    const parsed = parseUpdateType(renovateBody([{package:'a', type:'patch'}, {package:'b', type:'minor'}]));
    assert.equal(parsed.type, 'minor'); assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.packages[0], 'a');
    assert.equal(parseUpdateType(renovateBody([{package:'a', type:'patch'}])).type, 'patch');
    assert.equal(parseUpdateType(renovateBody([{package:'a', type:'digest'}])).type, 'digest');
    assert.equal(parseUpdateType(renovateBody([{package:'a', type:'pin'}])).type, 'pin');
    assert.ok(parseUpdateType('nothing here').error);
    assert.ok(parseUpdateType(renovateBody([{package:'a', type:'patch'}])).error === null);
});

// Renovate's own summary table is the first table of the body. Everything after
// it is upstream-controlled release-note text that Renovate copies verbatim.
function summaryTable(rows, header = '| Package | Update | Change |') {
    return ['This PR contains the following updates:', '', header, '|---|---|---|',
        ...rows.map(row => `| ${row.package} | ${row.type} | \`1.0.0\` → \`1.0.1\` |`), ''].join('\n');
}
test('pr-lane: only the first table before the release notes is the update table', () => {
    // An unsupported header is never searched past: the release notes table
    // that follows it is upstream text, not the summary.
    const payload = ['This PR contains the following updates:', '',
        '| Package | Update Type | Change |', '|---|---|---|', '| a | major | `1.0.0` → `2.0.0` |', '',
        '### Release Notes', '', '```', '| Package | Update |', '|---|---|', '| a | patch | `2.0.0` → `2.0.1` |', '```', ''].join('\n');
    const parsed = parseUpdateType(payload);
    assert.ok(parsed.error, 'an unsupported header waits instead of searching on');
    assert.equal(parsed.type, null); assert.deepEqual(parsed.packages, []);
    check(f => { f.pr.body = payload; }, 'wait', 'update type not derivable');
    // Several tables: the first one decides, the later ones are ignored.
    const two = summaryTable([{package:'a', type:'major'}]) + '\n' +
        summaryTable([{package:'b', type:'patch'}]);
    assert.equal(parseUpdateType(two).type, 'major');
    check(f => { f.pr.body = two; }, 'B', 'not all A');
    // A table in a code fence is not a table; the real summary table is used.
    const fenced = ['This PR contains the following updates:', '', '```', '| Package | Update |', '|---|---|',
        '| a | patch | `1.0.0` → `1.0.1` |', '```', '', summaryTable([{package:'b', type:'major'}])].join('\n');
    assert.equal(parseUpdateType(fenced).type, 'major');
    // An HTML table is not a markdown table: nothing is derived from it.
    const html = ['This PR contains the following updates:', '', '<table>', '<tr><td>Package</td><td>Update</td></tr>',
        '<tr><td>a</td><td>patch</td></tr>', '</table>', ''].join('\n');
    assert.ok(parseUpdateType(html).error);
    check(f => { f.pr.body = html; }, 'wait', 'update type not derivable');
    // Two Update columns are an unsupported schema, never a guess.
    const duplicate = parseUpdateType(summaryTable([{package:'a', type:'patch'}], '| Package | Update | Update | Change |'));
    assert.ok(duplicate.error); assert.equal(duplicate.type, null);
    check(f => { f.pr.body = summaryTable([{package:'a', type:'patch'}], '| Package | Update | Update | Change |'); }, 'wait', 'update type not derivable');
    // A Package column is part of the schema.
    assert.ok(parseUpdateType(summaryTable([{package:'a', type:'patch'}], '| Name | Update | Change |')).error);
    // An escaped pipe belongs to the cell and is not a column separator.
    const piped = parseUpdateType(summaryTable([{package:'a \\| b', type:'patch'}]));
    assert.equal(piped.error, null); assert.equal(piped.type, 'patch');
    assert.deepEqual(piped.packages, ['a | b']);
});
test('pr-lane: a table that only exists in the release notes waits', () => {
    for (const marker of ['### Release Notes', '<details>', '---', '### Configuration']) {
        const body = ['This PR contains the following updates:', '', marker, '',
            '| Package | Update | Change |', '|---|---|---|', '| a | patch | `1.0.0` → `1.0.1` |', ''].join('\n');
        const parsed = parseUpdateType(body);
        assert.ok(parsed.error, marker); assert.equal(parsed.type, null, marker);
        check(f => { f.pr.body = body; }, 'wait', 'update type not derivable');
    }
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

// These captured comments and statuses are kept byte-for-byte; only the
// surrounding PR/konflate evidence is synthetic to isolate review parsing.
function badgeFixture(number = 1596) {
    const fs = require('node:fs'), path = require('node:path');
    const f = fixture();
    f.comments[0].body = fs.readFileSync(path.join(__dirname, `testdata/kritika-0110-pr${number}.md`), 'utf8');
    f.statuses[0].description = fs.readFileSync(path.join(__dirname, `testdata/kritika-0110-pr${number}.status`), 'utf8').trim();
    const sha = f.comments[0].body.match(/Last reviewed commit:[^\n]*\/commit\/([a-f0-9]{40})\)/)[1];
    f.pr.number = number; f.pr.head.sha = sha; f.entry.headSha = sha;
    f.rendered.pr.headSha = sha; f.rendered.diff.headSha = sha;
    return f;
}
function checkBadge(mutate, lane, reason, number = 1596) {
    const f = badgeFixture(number); mutate(f); const result = classify(f);
    assert.equal(result.lane, lane, JSON.stringify(result));
    if (reason) assert.ok(result.reasons.some(r => r.includes(reason)), JSON.stringify(result.reasons));
    return result;
}
function insertFindings(f, content) {
    f.comments[0].body = f.comments[0].body.replace('### Summary', `## Findings\n\n${content}\n\n### Summary`);
}
const p1Badge = '<img alt="P1" src="https://kritika.janpuc.com/badges/p1.svg">';
test('pr-lane: kritika 0.0.110 real pr1668, pr1596, pr1580 and pr1595 reviews', () => {
    for (const [number, lane, confidence, risk, p1] of [
        [1668, 'C', 3, 'medium', 1], [1596, 'B', 5, 'medium', 0],
        [1580, 'C', 4, 'high', 0], [1595, 'B', 5, 'medium', 0]]) {
        const result = checkBadge(() => {}, lane, null, number);
        assert.equal(result.facts.kritika.parsed, true);
        assert.equal(result.facts.kritika.confidence, confidence);
        assert.equal(result.facts.kritika.risk, risk);
        assert.equal(result.facts.kritika.p1, p1);
    }
});
test('pr-lane: badge severity is scoped to Findings, never risk, Summary or details', () => {
    const result = checkBadge(f => {
        f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', `**[Medium risk]** ${p1Badge} P1`);
    }, 'B');
    assert.equal(result.facts.kritika.p1, 0);
    for (const end of ['### Summary', '## Summary', '<details>']) {
        const scoped = checkBadge(f => {
            f.statuses[0].description = 'kritika: confidence 5/5, 1 finding(s)';
            insertFindings(f, `**Outside the diff**\n\n- ${p1Badge.replaceAll('P1', 'P2').replace('p1.svg', 'p2.svg')} note\n\n${end}\n${p1Badge}`);
            f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', `**[Medium risk]** ${p1Badge}`);
        }, 'B');
        assert.equal(scoped.facts.kritika.p1, 0, end);
    }
    checkBadge(f => {
        f.statuses[0].description = 'kritika: confidence 5/5, 1 finding(s)';
        insertFindings(f, `### Outside the diff\n\n- ${p1Badge}`);
    }, 'C', 'P1 finding');
});
test('pr-lane: badge findings require a complete status-matching distribution', () => {
    for (const description of ['kritika: confidence 3/5, no findings', 'kritika: confidence 3/5, 2 finding(s)']) {
        const result = checkBadge(f => f.statuses[0].description = description, 'wait', 'badge count', 1668);
        assert.equal(result.facts.kritika.p1, null);
    }
    for (const content of ['No findings', '- P1: no badge', '- <img alt="P4" src="p4.svg">']) {
        checkBadge(f => insertFindings(f, content), 'wait', 'severity badges');
    }
    checkBadge(f => f.statuses[0].description = 'kritika: confidence 5/5, 1 finding(s)', 'wait', 'Findings section missing');
    for (const suffix of ['1 finding', '1 finding(s)']) {
        checkBadge(f => {
            f.statuses[0].description = `kritika: confidence 5/5, ${suffix}`;
            insertFindings(f, `- ${p1Badge}`);
        }, 'C', 'P1 finding');
    }
});
test('pr-lane: badge confidence, risk and status parsing fail closed', () => {
    const cases = [
        f => f.comments[0].body = f.comments[0].body.replace('Confidence Score: 5/5', 'Review'),
        f => f.comments[0].body = f.comments[0].body.replace('Confidence Score: 5/5', 'Confidence Score: 6/5'),
        f => f.statuses[0].description = 'kritika: confidence 4/5, no findings',
        f => f.statuses[0].description = 'kritika: confidence 5/5, findings unavailable',
        f => f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', 'No risk tag'),
        f => f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', '**[Unknown risk]**'),
    ];
    for (const mutate of cases) checkBadge(mutate, 'wait', 'unparseable');
    checkBadge(f => f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', '**[Critical risk]**'), 'C', 'high risk');
    checkBadge(f => f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', '**[High risk]**'), 'C', 'high risk');
    checkBadge(f => f.comments[0].body = f.comments[0].body.replace('**[Medium risk]**', '**[Low risk]**'), 'A');
    // New reviews retain the existing marker/actor/head-binding gates.
    checkBadge(f => f.comments[0].user.login = 'janpuc', 'wait', 'comment missing');
    checkBadge(f => f.comments[0].body = f.comments[0].body.replace(f.pr.head.sha, head), 'wait', 'stale');
});
test('pr-lane: P0 badges and legacy P0 counts are P1 or worse; legacy format still works', () => {
    checkBadge(f => {
        f.statuses[0].description = 'kritika: confidence 5/5, 1 finding(s)';
        insertFindings(f, `- ${p1Badge.replaceAll('P1', 'P0').replace('p1.svg', 'p0.svg')}`);
    }, 'C', 'P1 finding');
    check(() => {}, 'A');
    // Legacy reviews also contain badge Findings sections, including resolved
    // findings inside details. Those must not select the new-format parser.
    check(f => f.comments[0].body += `\n## Findings\n<details>\n- ${p1Badge}\n</details>`, 'A');
    check(f => f.comments[0].body += `\n## Findings\n- ${p1Badge}\n### Summary`, 'A');
    check(f => f.comments[0].body = f.comments[0].body.replace('**No findings**', '**1 finding** · 1 P0'), 'C', 'P1 finding');
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
if(p==='graphql') {
 const query=args[3].slice(6), comment=query.includes('IC_test');
 let node;
 if(query.includes('userContentEdits(')) {
  const bad=process.env.BAD_HISTORY && (process.env.BAD_HISTORY==='comment')===comment;
  node={userContentEdits:{totalCount:bad?1:0,nodes:bad?[{editor:{login:'janpuc-agent'}}]:[],pageInfo:{hasNextPage:false,endCursor:null}}};
  if(process.env.INCOMPLETE_EDITS) node.userContentEdits.totalCount=1;
 }
 else if(query.includes('timelineItems(')) {
 const second=query.includes('after:'), paginated=!!process.env.PAGINATED, draft=process.env.DRAFT_EVENT;
 node={timelineItems:{totalCount:paginated?2:1,nodes:draft?[{__typename:draft,actor:{login:process.env.DRAFT_ACTOR||'pocket'}}]:[{__typename:second?'RenamedTitleEvent':'LabeledEvent',actor:{login:second?'janpuc-agent':process.env.BAD_ACTOR||'bot-atlas'}}],pageInfo:{hasNextPage:paginated&&!second,endCursor:paginated&&!second?'next':null}}};
 if(process.env.BROKEN_CURSOR) node.timelineItems.pageInfo={hasNextPage:true,endCursor:null};
 }
 else node={body:comment?f.comments[0].body:f.pr.body,editor:process.env.BAD_EDITOR?{login:'janpuc-agent'}:null};
 console.log(JSON.stringify({data:{node}}));process.exit(0);
}
else if(p.includes('/git/ref/heads/main')) value={object:{sha:'c'.repeat(40)}};
else if(p.includes('/compare/')) value={base_commit:{sha:'c'.repeat(40)},merge_base_commit:{sha:'d'.repeat(40)},total_commits:1,commits:[{sha:f.pr.head.sha}],files:process.env.INCOMPLETE?Array(300).fill({filename:'file'}):[{filename:f.files[0],...(process.env.RENAME ? {previous_filename:'talos/old.yaml'} : {})}]};
else if(p.includes('/status?')) value={statuses:f.statuses};
else if(p.includes('/check-runs?')) value={check_runs:f.checks};
else if(p.includes('/comments?')) value=f.comments;
else if(p.includes('/pulls?')) value=[f.pr];
else value={...f.pr, ...(process.env.MOVED ? {head:{sha:'b'.repeat(40)}} : {}), ...(process.env.RETARGET ? {base:{ref:'harmless',repo:{full_name:'janpuc/home-ops'}}} : {})};
console.log(JSON.stringify(args.includes('--slurp')?[value]:value));
`, {mode:0o755});
    const env={...process.env,PATH:dir+':'+process.env.PATH,FIXTURE:path.join(dir,'fixture.json'),CALLS:path.join(dir,'calls')};
    const run=()=> {const r=cp.spawnSync(process.execPath,['--require',path.join(dir,'preload.cjs'),path.join(__dirname,'pr-lane'),'--all','--json','--gh',path.join(dir,'gh')],{env,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout)[0];};
    f.rendered.diff.chromaCss='huge css'; fs.writeFileSync(env.FIXTURE,JSON.stringify(f));
    assert.equal(run().lane,'A'); assert.ok(!JSON.stringify(run()).includes('huge css'));
    const calls=fs.readFileSync(env.CALLS,'utf8').trim().split('\n').map(JSON.parse);
    for(const call of calls.filter(c=>c[1].includes('?'))) { assert.ok(call.includes('--paginate')); assert.ok(call.includes('--slurp')); }
    env.RENAME='1'; assert.equal(run().lane,'C'); delete env.RENAME;
    env.MOVED='1'; assert.equal(run().lane,'wait'); delete env.MOVED;
    env.INCOMPLETE='1'; assert.equal(run().lane,'wait'); delete env.INCOMPLETE;
    env.BAD_ACTOR='janpuc-agent'; assert.ok(run().reasons.includes('PR metadata changed by janpuc-agent')); delete env.BAD_ACTOR;
    env.BAD_EDITOR='1'; assert.ok(run().reasons.includes('kritika comment edited by janpuc-agent')); delete env.BAD_EDITOR;
    for (const flag of ['PAGINATED','BAD_HISTORY']) {
        env[flag]=flag==='BAD_HISTORY'?'pr':'1';
        assert.ok(run().reasons.includes('PR metadata changed by janpuc-agent')); delete env[flag];
    }
    env.BAD_HISTORY='comment'; assert.ok(run().reasons.includes('kritika comment edited by janpuc-agent')); delete env.BAD_HISTORY;
    // A draft transition by an untrusted actor that already happened, before the
    // first REST read, is C and names the actor.
    for (const [event, reason] of [['ReadyForReviewEvent','draft state changed by pocket'],
        ['ConvertToDraftEvent','draft state changed by pocket'],
        ['BaseRefChangedEvent','base ref changed by pocket'],
        ['BaseRefForcePushedEvent','base ref changed by pocket']]) {
        env.DRAFT_EVENT=event; const result=run();
        assert.equal(result.lane,'C',event); assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    }
    delete env.DRAFT_EVENT;
    // An unknown or null actor is untrusted too.
    env.DRAFT_EVENT='ReadyForReviewEvent'; env.DRAFT_ACTOR='janpuc-agent';
    assert.ok(run().reasons.includes('draft state changed by janpuc-agent')); delete env.DRAFT_ACTOR; delete env.DRAFT_EVENT;
    for (const flag of ['INCOMPLETE_EDITS','BROKEN_CURSOR','RETARGET']) { env[flag]='1'; assert.equal(run().lane,'wait'); delete env[flag]; }
    assert.ok(calls.every(c => !c[1].includes('/files?')));
});


test('pr-lane rejects other base branches/repositories even when the head is unchanged', () => {
    check(f => f.pr.base.ref = 'harmless', 'C', 'base must be');
    check(f => f.pr.base.repo.full_name = 'janpuc/other', 'C', 'base must be');
});
test('pr-lane compare evidence binds main and merge-base and refuses incomplete/capped data', () => {
    const { compareEvidence } = require('./pr-lane');
    const main = 'c'.repeat(40), mergeBase = 'd'.repeat(40);
    const page = { base_commit: { sha: main }, merge_base_commit: { sha: mergeBase }, total_commits: 2,
        commits: [{ sha: head }], files: [{ filename: 'safe/file', previous_filename: 'talos/old' }] };
    const second = { total_commits: 2, commits: [{ sha: 'b'.repeat(40) }] };
    assert.deepEqual(compareEvidence(main, head, [page, second]), { main_sha: main, merge_base: mergeBase, files: ['safe/file','talos/old'] });
    assert.throws(() => compareEvidence(main, head, [page]), /incomplete/);
    for (const delta of [{ files: Array(300).fill({ filename: 'safe' }) }, { merge_base_commit: null }, { base_commit: { sha: head } }])
        assert.throws(() => compareEvidence(main, head, [{ ...page, ...delta }, second]), /incomplete/);
});
