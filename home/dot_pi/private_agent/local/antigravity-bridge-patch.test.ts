// Checks the installed pi-antigravity-bridge carries the trailing prompt patch from
// .chezmoitemplates/pi-antigravity-bridge-1.13.1.patch. Skipped where the bridge is not installed (only aether runs Neon).
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dirname, "../npm/node_modules/@estebanforge/pi-antigravity-bridge/src");
const skip = existsSync(join(src, "provider.ts")) ? false : "pi-antigravity-bridge is not installed here";

// Node strips types only outside node_modules, so test a copy. It imports nothing.
const load = async () => {
	const copy = join(mkdtempSync(join(tmpdir(), "agb-test-")), "trailing-user.ts");
	copyFileSync(join(src, "trailing-user.ts"), copy);
	return await import(copy);
};
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };

test("the prompt keeps the user's message when an extension block follows it", { skip }, async () => {
	const { trailingUserText } = await load();
	const prompt = trailingUserText([user("old"), assistant, user("fix the shelf"), user("# Mandatory project context")]);
	assert.equal(prompt, "fix the shelf\n\n# Mandatory project context");
});

test("a compaction summary stays out of the prompt", { skip }, async () => {
	const { trailingUserStart, trailingUserText } = await load();
	const messages = [user("summary"), user("next step")];
	assert.equal(trailingUserStart(messages, 1), 1);
	assert.equal(trailingUserText(messages, 1), "next step");
});

test("provider builds the prompt, images and digest from the trailing run", { skip }, () => {
	const provider = readFileSync(join(src, "provider.ts"), "utf8");
	assert.match(provider, /return trailingUserText\(context\.messages, findLastCompactionIdx\(context\.messages\) \+ 1\);/);
	assert.match(provider, /return trailingUserImages\(context\.messages, findLastCompactionIdx\(context\.messages\) \+ 1\);/);
	assert.match(provider, /Math\.min\(messages\.length - 1, trailingUserStart\(messages, compactionIdx \+ 1\)\)/);
});
