const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runBroker } = require('./pr-broker');
const { submit } = require('./pr-merge-request');
const head = 'a'.repeat(40);
function fixture(t) {
    const root = fs.mkdtempSync(join(tmpdir(), 'pr-broker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const o = { node: process.execPath, gh: join(root, 'gh'), lane: join(root, 'lane.cjs'),
        state: join(root, 'state'), config: join(root, 'config'), spool: join(root, 'spool'), tokenProvider: async () => 'test-token' };
    for (const dir of [o.state, o.config, join(o.spool, 'requests'), join(o.spool, 'staging'), join(o.spool, 'results')]) fs.mkdirSync(dir, { recursive: true });
    const dataFile = join(root, 'data.json'), callsFile = join(root, 'calls.jsonl');
    const data = { prs: [{ pr: 42, head, lane: 'A', reasons: ['evidence'], facts: { createdAt: '2026-01-01' } }] };
    const save = () => fs.writeFileSync(dataFile, JSON.stringify(data)); save();
    fs.writeFileSync(o.lane, `const fs=require('node:fs'), d=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));
const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({tool:'lane',args:a,PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS})+'\\n');
if(d.laneError) process.exit(1);
console.log(JSON.stringify(a[0]==='--all'?d.prs:{...d.prs.find(p=>p.pr===Number(a[0])),...d.fresh}));`);
    fs.writeFileSync(o.gh, `#!${process.execPath}
const fs=require('node:fs'),d=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({tool:'gh',args:process.argv.slice(2),tokenPresent:process.env.GH_TOKEN==='test-token'})+'\\n');
if(d.fail) process.exit(1);`, { mode: 0o755 });
    // Emulate root ownership only for test switches, without needing a root test runner.
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const stat = lstat(file, ...args);
        stat.uid = 0;
        if (!String(file).endsWith('.enabled')) stat.mode &= ~0o022;
        return stat;
    });
    return { o, data, save, root,
        enable: (mode = 'requests') => fs.writeFileSync(join(o.config, `${mode}.enabled`), '', { mode: 0o644 }),
        request: (pr = 42, sha = head) => submit([String(pr), sha], o.spool),
        result: file => JSON.parse(fs.readFileSync(file, 'utf8')),
        results: () => fs.readdirSync(join(o.spool, 'results')).map(n => JSON.parse(fs.readFileSync(join(o.spool, 'results', n), 'utf8'))),
        pending: () => fs.readdirSync(join(o.spool, 'requests')),
        calls: () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [],
        run: (mode = 'requests') => runBroker(mode, o) };
}
module.exports = { fixture, head };

