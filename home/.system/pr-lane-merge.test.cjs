const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'pr-lane-merge-'));
    t.after(() => rmSync(root,{recursive:true,force:true}));
    const bin = join(root,'bin'), config = join(root,'.config/pi-pocket'); mkdirSync(bin); mkdirSync(config,{recursive:true});
    const env = {...process.env, HOME:root, PATH:bin+':'+process.env.PATH, CALLS:join(root,'calls')};
    writeFileSync(join(bin,'pr-lane'), `#!/usr/bin/env node
const args=process.argv.slice(2), fs=require('node:fs');
fs.appendFileSync(process.env.CALLS, 'lane '+args.join(' ')+'\\n');
const prs=Array.from({length:8},(_,i)=>({pr:i+1, head:'a'.repeat(40), lane:i===0?'B':'A',facts:{createdAt:'2026-01-0'+(9-i)}}));
console.log(JSON.stringify(args[0]==='--all'?prs: {...prs.find(p=>p.pr===Number(args[0])), ...(process.env.STALE ? {head:'b'.repeat(40)} : {})}));
`,{mode:0o755});
    writeFileSync(join(bin,'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.CALLS,'gh '+process.argv.slice(2).join(' ')+'\\n');
if(process.env.FAIL) process.exit(1);
`,{mode:0o755});
    return {root, config, env, run:()=>spawnSync(process.execPath,[join(__dirname,'pr-lane-merge')],{env,encoding:'utf8'}),
        calls:()=>readFileSync(env.CALLS,'utf8').trim().split('\n')};
}
test('pr-lane-merge defaults dry-run; oldest first, at most five, never B', t => {
    const f=fixture(t), r=f.run(); assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/DRY-RUN/);
    assert.equal(existsSync(join(f.config,'pr-lane-merge.enabled')),false);
    assert.equal(f.calls().filter(s=>s.startsWith('gh ')).length,0);
    assert.deepEqual(f.calls().slice(1),[8,7,6,5,4].map(n=>`lane ${n} --json`));
});
test('pr-lane-merge opt-in merges exact command, stops at first failure', t => {
    const f=fixture(t); writeFileSync(join(f.config,'pr-lane-merge.enabled'),''); f.env.FAIL='1';
    assert.notEqual(f.run().status,0);
    assert.deepEqual(f.calls(),['lane --all --json','lane 8 --json',`gh pr merge 8 -R janpuc/home-ops --squash --match-head-commit ${'a'.repeat(40)}`]);
});
test('pr-lane-merge opt-in merges at most five', t => {
    const f=fixture(t); writeFileSync(join(f.config,'pr-lane-merge.enabled'),'');
    assert.equal(f.run().status,0);
    assert.deepEqual(f.calls().filter(c=>c.startsWith('gh ')),[8,7,6,5,4].map(n=>`gh pr merge ${n} -R janpuc/home-ops --squash --match-head-commit ${'a'.repeat(40)}`));
});
test('pr-lane-merge rechecks head/lane before merging', t => {
    const f=fixture(t); writeFileSync(join(f.config,'pr-lane-merge.enabled'),''); f.env.STALE='1';
    assert.equal(f.run().status,0);
    assert.equal(f.calls().filter(s=>s.startsWith('gh ')).length,0);
});
