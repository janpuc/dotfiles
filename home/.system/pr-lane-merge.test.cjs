const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, head } = require('./pr-broker-test-fixture.cjs');
function candidates(f) {
    f.data.prs = Array.from({ length: 8 }, (_, i) => ({ pr: i + 1, head, lane: i === 0 ? 'B' : 'A',
        facts: { createdAt: `2026-01-0${9 - i}` } })); f.save();
}
test('pr-lane-merge dry-run, oldest first, at most five, never B', async t => {
    const f = fixture(t); candidates(f);
    assert.equal(await f.run('lane-a'), true);
    assert.deepEqual(f.calls().map(c => c.args[0]), ['--all', '8', '7', '6', '5', '4']);
    assert.ok(f.results().every(r => r.status === 'dry-run'));
});
test('pr-lane-merge uses separate switch and same pinned merge path, at most five', async t => {
    const f = fixture(t); candidates(f); f.enable();
    assert.equal(await f.run('lane-a'), true);
    assert.equal(f.calls().filter(c => c.tool === 'gh').length, 0);
    f.enable('lane-a'); assert.equal(await f.run('lane-a'), true);
    const merges = f.calls().filter(c => c.tool === 'gh'); assert.equal(merges.length, 5);
    assert.deepEqual(merges.map(c => c.args[2]), ['8', '7', '6', '5', '4']);
    assert.ok(merges.every(c => c.args.at(-1) === head && c.args.at(-2) === '--match-head-commit'));
});
test('pr-lane-merge stops on first merge failure, changed head, or lane no longer A', async t => {
    for (const change of [{ fail: true }, { fresh: { head: 'b'.repeat(40) } }, { fresh: { lane: 'B' } }]) {
        const f = fixture(t); candidates(f); f.enable('lane-a'); Object.assign(f.data, change); f.save();
        assert.equal(await f.run('lane-a'), false);
        assert.deepEqual(f.calls().filter(c => c.tool === 'lane').map(c => c.args[0]), ['--all', '8']);
        assert.equal(f.results().length, 1);
        assert.ok(['error', 'refused'].includes(f.results()[0].status));
    }
});
