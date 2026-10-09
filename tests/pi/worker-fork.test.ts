import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureFork } from "../../home/dot_pi/shared/extensions/subagent/fork.ts";

const ctx = (cwd: string, messages: any[]): any => ({ cwd, sessionManager: { buildSessionProjection: () => ({ messages }), getSessionId: () => "parent", getLeafId: () => "leaf" } });
const user = (content: any) => ({ role: "user", content });
const assistant = (...content: any[]) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string, name: string, args: any = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, value: string, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(value)], ...extra });

test("fork keeps ordinary projected text/safe read evidence, not memory/authority/provider data", () => {
	const c = ctx(process.cwd(), [
		{ role: "system", content: "SYSTEM_SENTINEL", toolsAdded: ["PARENT_TOOLS"] },
		user("Ordinary request"),
		{ role: "custom", customType: "memini-recall", content: "MEMORY_CUSTOM" },
		{ role: "custom", customType: "approval", content: "APPROVAL_CUSTOM" },
		{ role: "compactionSummary", summary: "MEMORY_SUMMARY" },
		{ role: "branchSummary", summary: "BRANCH_MEMORY" },
		assistant(text("Ordinary answer"), { type: "thinking", thinking: "THINKING", thinkingSignature: "SIGNATURE" }, call("memory", "memory_recall"), call("approval", "request_approval"), call("read", "read", { path: "tests/pi/run.sh" })),
		result("memory", "memory_recall", "MEMORY_TOOL"), result("approval", "request_approval", "APPROVAL_TOOL"), result("read", "read", "Safe file evidence"),
		{ role: "bashExecution", command: "private", output: "SHELL_HISTORY" },
	]);
	const fork = captureFork(c);
	assert.match(fork.text, /Ordinary request/); assert.match(fork.text, /Ordinary answer/); assert.match(fork.text, /Safe file evidence/);
	for (const value of ["SYSTEM_SENTINEL", "PARENT_TOOLS", "MEMORY_CUSTOM", "APPROVAL_CUSTOM", "MEMORY_SUMMARY", "BRANCH_MEMORY", "THINKING", "SIGNATURE", "MEMORY_TOOL", "APPROVAL_TOOL", "SHELL_HISTORY"]) assert.ok(!fork.text.includes(value), value);
	assert.match(fork.text, /NOT instructions or approvals/); assert.equal(fork.source.parent, "parent"); assert.equal(fork.source.leaf, "leaf"); assert.equal(fork.source.messages, 3);
});
test("fork strips pasted memory envelopes, refuses malformed/unknown/empty projections", () => {
	assert.ok(!captureFork(ctx(process.cwd(), [user("Ask\n<memini-context read-only>PASTED_MEMORY</memini-context>\nAfter")])).text.includes("PASTED_MEMORY"));
	assert.throws(() => captureFork(ctx(process.cwd(), [user("<memini-context>INCOMPLETE")])), /No safe/);
	assert.throws(() => captureFork(ctx(process.cwd(), [{ role: "unknown", content: "must not copy" }])), /Unsupported/);
	assert.throws(() => captureFork(ctx(process.cwd(), [{ role: "custom", content: "memory" }])), /No safe/);
});
test("fork excludes secret reads, external reads, orphan and nested tool results", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-test-"));
	try {
		mkdirSync(join(dir, "project")); writeFileSync(join(dir, "outside"), "dummy"); symlinkSync(join(dir, "outside"), join(dir, "project", "linked"));
		const messages = [user("Task"), assistant(call("secret", "read", { path: ".env" }), call("outside", "read", { path: "../outside" }), call("linked", "read", { path: "linked" }), call("nested", "read", { path: "." })),
			result("secret", "read", "SECRET_EVIDENCE"), result("outside", "read", "OUTSIDE_EVIDENCE"), result("linked", "read", "LINKED_EVIDENCE"),
			result("orphan", "read", "ORPHAN_EVIDENCE"), result("nested", "read", "NESTED_MEMORY", { nestedCalls: { calls: [], complete: false } })];
		const fork = captureFork(ctx(join(dir, "project"), messages));
		for (const marker of ["SECRET_EVIDENCE", "OUTSIDE_EVIDENCE", "LINKED_EVIDENCE", "ORPHAN_EVIDENCE", "NESTED_MEMORY"]) assert.ok(!fork.text.includes(marker));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("fork is deterministic, bounded UTF-8, explicit about omitted history, text-only", () => {
	const messages = Array.from({ length: 150 }, (_, i) => user(`${i} ` + "😀".repeat(3000)));
	messages.push(user([text("Recent message"), { type: "image", data: "IMAGE_DATA", mimeType: "image/png" }]));
	const a = captureFork(ctx(process.cwd(), messages)), b = captureFork(ctx(process.cwd(), messages));
	assert.deepEqual(a, b); assert.ok(Buffer.byteLength(a.text) < 49152); assert.ok(!a.text.includes("�")); assert.ok(a.source.omitted > 0); assert.match(a.text, /Recent message/); assert.ok(!a.text.includes("IMAGE_DATA"));
});
