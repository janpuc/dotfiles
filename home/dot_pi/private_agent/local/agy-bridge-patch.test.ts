// Checks the installed pi-agy-bridge carries the JSON repair patch from
// .chezmoitemplates/pi-agy-bridge-0.1.5.patch. Skipped where the bridge is not installed (only aether runs Neon).
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = join(import.meta.dirname, "../npm/node_modules/@timmyjl12/pi-agy-bridge/src/tool-protocol.ts");
const skip = existsSync(source) ? false : "pi-agy-bridge is not installed here";

// Node strips types only outside node_modules, so test a copy. It imports only node: builtins.
let copy: string | undefined;
const load = async () => {
	if (!copy) {
		copy = join(mkdtempSync(join(tmpdir(), "agy-bridge-test-")), "tool-protocol.ts");
		copyFileSync(source, copy);
	}
	return await import(copy);
};
const call = async (body: string) => {
	const { ToolCallStreamParser } = await load();
	const parser = new ToolCallStreamParser({ makeId: () => "id" });
	const events = [...parser.push(`text <pi_tool_call name="codemode">${body}</pi_tool_call>`), ...parser.end()];
	return events.find((event: { type: string }) => event.type === "toolCall").call;
};

test("invalid escapes in code mean a literal backslash", { skip }, async () => {
	const result = await call(String.raw`{"code": "const r = /\d+\.ts$/; const s = '\$x' + \"q\";\nreturn r"}`);
	assert.equal(result.argumentsError, undefined);
	assert.equal(result.arguments.code, String.raw`const r = /\d+\.ts$/; const s = '\$x' + "q";` + "\nreturn r");
});

test("raw newlines and tabs inside strings are escaped", { skip }, async () => {
	const result = await call('{"path": "a.txt", "content": "line 1\nline\t2"}');
	assert.equal(result.argumentsError, undefined);
	assert.equal(result.arguments.content, "line 1\nline\t2");
});

test("valid JSON is never rewritten", { skip }, async () => {
	const { repairJsonStrings } = await load();
	const body = String.raw`{"code": "a\\dA\n", "x": "\"\\\/"}`;
	assert.equal(repairJsonStrings(body), body);
	assert.deepEqual((await call(body)).arguments, JSON.parse(body));
});

test("an unrepairable body reports the text around the error", { skip }, async () => {
	const pad = "x".repeat(400);
	const result = await call(`{"code": "${pad}" oops "${pad}"}`);
	assert.match(result.argumentsError, /not valid JSON/);
	assert.match(result.argumentsError, /\[\.\.\.\]x+" <<HERE>>oops/);
});

test("the protocol tells Neon how to escape code", { skip }, async () => {
	const text = (await load()).renderToolProtocol([]);
	assert.ok(text.includes(String.raw`Write each backslash of the code as \\ (a regex \d is written \\d) and each double quote as \".`));
	assert.ok(text.includes("must be escaped as \\${...} (written \\\\${...} inside JSON)"));
});
