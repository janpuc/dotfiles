// Unit tests for home/dot_pi/shared/extensions/profile/commit-trailers.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAiTrailers } from "../../home/dot_pi/shared/extensions/profile/commit-trailers.ts";

test("a separate -m holding only the trailer is dropped (seen in home-ops)", () => {
	const r = stripAiTrailers(`cd ~/Development/home-ops && git add x && git commit -q -m "feat(ai): tuiter 1.1.0" -m "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin main`);
	assert.deepEqual(r, { command: `cd ~/Development/home-ops && git add x && git commit -q -m "feat(ai): tuiter 1.1.0" && git push origin main` });
});

test("heredoc trailer and Generated-with lines are removed, the message kept", () => {
	const cmd = [`git commit -F - <<'EOF'`, `fix: thing`, ``, `Body.`, ``, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, ``, `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, `EOF`].join("\n");
	const r = stripAiTrailers(cmd)!;
	assert.equal(r.leftover, undefined);
	assert.equal(r.command, [`git commit -F - <<'EOF'`, `fix: thing`, ``, `Body.`, ``, ``, `EOF`].join("\n"));
});

test("other models are caught too", () => {
	for (const who of ["Codex <noreply@openai.com>", "GPT-6.1 Sol <x@y>", "MiniMax M3 <m@minimax.io>", "GLM-5.3 <g@z.ai>", "Kimi K3 <k@moonshot.ai>", "opencode <noreply@opencode.ai>"]) {
		const r = stripAiTrailers(`git commit -m "fix: x" -m "Co-authored-by: ${who}"`);
		assert.deepEqual(r, { command: `git commit -m "fix: x"` }, who);
	}
});

test("people keep their co-author lines", () => {
	for (const who of ["Claude Dupont <claude@example.com>", "Kimi Räikkönen <kimi@example.com>", "Nikola <n@example.com>"])
		assert.equal(stripAiTrailers(`git commit -m "fix: x" -m "Co-authored-by: ${who}"`), undefined, who);
});

test("a trailer inside a one-line message is reported, not rewritten", () => {
	const r = stripAiTrailers(`git commit -m $'fix: x\\n\\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>'`)!;
	assert.match(r.leftover!, /^Co-authored-by: Claude Opus 5\.5/);
});

test("non-commit commands are left alone", () => {
	assert.equal(stripAiTrailers(`git log --grep "Co-authored-by: Claude Opus"`), undefined);
	assert.equal(stripAiTrailers(`echo "Co-authored-by: Claude Opus 5.5" > notes.md`), undefined);
	assert.equal(stripAiTrailers(`git commit -m "fix: plain"`), undefined);
});
