// Checks the installed pi-agy-bridge carries the native tools patch from
// .chezmoitemplates/pi-agy-bridge-0.1.5-mcp.patch: the relay agy starts reaches the MCP host inside pi over a Unix
// socket with its agy process token, lists pi's tools and routes a call to the waiting turn of its conversation.
// Skipped where the bridge is not installed (only aether runs Neon).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const pkg = join(import.meta.dirname, "../npm/node_modules/@timmyjl12/pi-agy-bridge/src");
const skip = existsSync(join(pkg, "acp/mcp-host.ts")) ? false : "pi-agy-bridge with the native tools patch is not installed here";

// Node strips types only outside node_modules, so test a copy. These files import only node: builtins.
const copy = () => {
	const root = mkdtempSync(join(tmpdir(), "agy-bridge-mcp-"));
	mkdirSync(join(root, "acp"));
	const files = ["tool-protocol.ts", "acp/mcp-host.ts", "acp/mcp-relay.mjs", "acp/connection.ts", "acp/jsonrpc.ts", "acp/frame-guard.ts", "acp/process-tree.ts", "acp/types.ts"];
	for (const file of files) copyFileSync(join(pkg, file), join(root, file));
	return root;
};

// A stand-in for `agy acp`: a prompt asks for two permissions (pi's MCP tool, then agy's own run_command), reports
// the outcomes as message chunks and ends the turn.
const FAKE_AGY = String.raw`
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + String.fromCharCode(10));
let next = 1000; const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
const chunk = (sessionId, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const options = [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }];
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const pi = await ask("session/request_permission", { sessionId: "s1", options, toolCall: { name: "call_mcp_tool", rawInput: { ServerName: "pi", ToolName: "read" } } });
    const own = await ask("session/request_permission", { sessionId: "s1", options, toolCall: { name: "run_command", kind: "execute", title: "echo" } });
    chunk("s1", "pi=" + pi?.outcome?.optionId + " ");
    chunk("s1", "own=" + (own?.outcome?.optionId ?? own?.outcome?.outcome));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

const relay = (root: string, socket: string | undefined, token = "") => {
	const env = { ...process.env };
	delete env.PI_AGY_MCP_SOCKET;
	delete env.PI_AGY_MCP_TOKEN;
	if (socket) env.PI_AGY_MCP_SOCKET = socket;
	env.PI_AGY_MCP_TOKEN = token;
	const child = spawn(process.execPath, [join(root, "acp/mcp-relay.mjs")], { env, stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout! });
	const waiting = new Map<number, (message: any) => void>();
	lines.on("line", (line) => {
		const message = JSON.parse(line);
		waiting.get(message.id)?.(message);
	});
	let id = 0;
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	const request = (method: string, params: unknown = {}) =>
		new Promise<any>((resolve) => {
			id += 1;
			waiting.set(id, resolve);
			child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	return { request, exited, close: () => child.kill() };
};

const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

test("the relay lists pi's tools and a call reaches the turn of its conversation", { skip }, async () => {
	const root = copy();
	const { McpHost } = await import(join(root, "acp/mcp-host.ts"));
	const host = new McpHost();
	host.advertise([tool]);
	const socket = await host.start(join(root, "sock"));
	const token = host.issueToken();
	const agy = relay(root, socket, token);
	try {
		const init = await agy.request("initialize", { protocolVersion: "2025-11-25" });
		assert.equal(init.result.serverInfo.name, "pi");
		const list = await agy.request("tools/list");
		assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["read"]);
		assert.equal(list.result.tools[0].inputSchema.type, "object");

		const other = host.route("conv-2", host.issueToken(), () => assert.fail("a call reached another process's turn"));
		const stolen = await agy.request("tools/call", { _meta: { "antigravity.google/conversation_id": "conv-2" }, name: "read", arguments: {} });
		assert.equal(stolen.result.isError, true);
		other();

		const off = host.route("conv-1", token, (call: any) => {
			assert.equal(call.name, "read");
			assert.deepEqual(call.arguments, { path: "a.txt" });
			setTimeout(() => call.respond([{ type: "text", text: "alpha" }], false), 50);
		});
		const meta = { "antigravity.google/conversation_id": "conv-1" };
		const answered = await agy.request("tools/call", { _meta: meta, name: "read", arguments: { path: "a.txt" } });
		assert.deepEqual(answered.result, { content: [{ type: "text", text: "alpha" }], isError: false });

		off();
		const orphan = await agy.request("tools/call", { _meta: meta, name: "read", arguments: {} });
		assert.equal(orphan.result.isError, true);
		assert.match(orphan.result.content[0].text, /did not run/);
	} finally {
		agy.close();
		host.close();
	}
});

test("a connection without a known token is closed", { skip }, async () => {
	const root = copy();
	const { McpHost } = await import(join(root, "acp/mcp-host.ts"));
	const host = new McpHost();
	const socket = await host.start(join(root, "sock"));
	host.issueToken();
	const agy = relay(root, socket, "not-a-token");
	try {
		void agy.request("tools/list");
		// The host closes the socket, so the relay exits (0 on close, 1 on a reset) instead of serving tools.
		assert.ok([0, 1].includes((await agy.exited) as number));
	} finally {
		agy.close();
		host.close();
	}
});

test("every listener of a session hears its updates, and only pi's MCP tools get permission", { skip }, async () => {
	const root = copy();
	const fake = join(root, "fake-agy.mjs");
	writeFileSync(fake, FAKE_AGY);
	const { AcpProcess, PERMISSION_DENIED_UPDATE } = await import(join(root, "acp/connection.ts"));
	const proc = AcpProcess.start({ command: process.execPath, args: [fake], cwd: root, controlTimeoutMs: 10_000 });
	try {
		await proc.initialize();
		const { sessionId } = await proc.newSession({ cwd: root });
		// The pi turn and, alongside it, a parked turn's tripwire (stream.ts) listen to the same session.
		const turn: string[] = [];
		const tripwire: string[] = [];
		const denied: string[] = [];
		const offTurn = proc.listen(sessionId, (update: any) => {
			if (update.sessionUpdate === "agent_message_chunk") turn.push(update.content.text);
			if (update.sessionUpdate === PERMISSION_DENIED_UPDATE) denied.push(update.toolCall.name);
		});
		const offTripwire = proc.listen(sessionId, (update: any) => tripwire.push(update.sessionUpdate));
		const result = await proc.prompt(sessionId, [{ type: "text", text: "go" }]);
		assert.equal(result.stopReason, "end_turn");
		assert.equal(turn.join(""), "pi=allow own=reject");
		assert.deepEqual(denied, ["run_command"]);
		assert.ok(tripwire.includes("agent_message_chunk"));
		// Removing one listener leaves the other in place.
		offTripwire();
		turn.length = 0;
		await proc.prompt(sessionId, [{ type: "text", text: "again" }]);
		assert.equal(turn.join(""), "pi=allow own=reject");
		offTurn();
	} finally {
		await proc.dispose();
	}
});

test("each agy process keeps the tool catalogue of its start, and the catalogue only grows", { skip }, async () => {
	const { McpHost } = await import(join(copy(), "acp/mcp-host.ts"));
	const host = new McpHost();
	const empty = host.issueToken();
	assert.equal(host.covers(empty, [tool]), false);
	host.advertise([tool]);
	// A process lists the catalogue of its start: a later tool needs a new process, fewer tools do not.
	assert.equal(host.covers(empty, [tool]), false);
	const first = host.issueToken();
	assert.equal(host.covers(first, [tool]), true);
	assert.equal(host.covers(first, []), true);
	// codemode rewrites its description as tools come and go: only a new schema needs a new agy.
	assert.equal(host.covers(first, [{ ...tool, description: "changed" }]), true);
	assert.equal(host.covers(first, [{ ...tool, parameters: { type: "object", properties: {} } }]), false);
	host.advertise([{ name: "bash", description: "Run", parameters: {} }]);
	assert.equal(host.covers(first, [tool]), true);
	assert.equal(host.covers(host.issueToken(), [tool]), true);
	assert.equal(host.covers("unknown", []), false);
});

test("without a socket the relay is a server with no tools", { skip }, async () => {
	const agy = relay(copy(), undefined);
	try {
		const list = await agy.request("tools/list");
		assert.deepEqual(list.result.tools, []);
	} finally {
		agy.close();
	}
});

test("the carrier agent allows call_mcp_tool and keeps agy's write, command and web tools away", { skip }, () => {
	const staging = readFileSync(join(pkg, "acp/staging.ts"), "utf8");
	const frontmatter = staging.slice(staging.indexOf("const FRONTMATTER"), staging.indexOf("];", staging.indexOf("const FRONTMATTER")));
	// tools: [] and excludeDefaultComponents hide call_mcp_tool, a frontmatter mcpServers list brings run_command back.
	assert.doesNotMatch(frontmatter, /tools: \[\]|excludeDefaultComponents|mcpServers/);
	// The allowlist agy enforces before anything runs: read_file (refused at its permission prompt) plus call_mcp_tool.
	assert.match(frontmatter, /'tools: \["read_file"\]'/);
	assert.match(frontmatter, /commandExecutionPolicy: off/);
	const connection = readFileSync(join(pkg, "acp/connection.ts"), "utf8");
	assert.match(connection, /call\.name === "call_mcp_tool"/);
});
