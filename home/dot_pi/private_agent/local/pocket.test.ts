import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

// Use Pi's actual loader and TypeBox export; only registerTool and the remote server are fake.
const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const brewBin = resolve(dirname(piBin), "../libexec/bin/pi");
const requirePi = createRequire(existsSync(brewBin) ? realpathSync(brewBin) : piBin);
const { createJiti } = requirePi("jiti");
const piAi = requirePi.resolve.paths("@earendil-works/pi-ai")!.map((path) => resolve(path, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
assert.ok(piAi, "Pi's pi-ai package must be installed");
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { "@earendil-works/pi-ai": piAi } });
const extension = await jiti.import(new URL("./pocket.ts", import.meta.url).pathname, { default: true });
const tools = new Map<string, any>();
extension({ registerTool(tool: any) { tools.set(tool.name, tool); } });

const TOKEN = "fake-pocket-secret-never-in-output";
const assistant = (id: number, text: string, extra = {}) => ({ id, kind: "assistant", blocks: [{ type: "thinking", text: "private reasoning" }, { type: "text", text }], stopReason: "stop", ...extra });
const originalEnv = { url: process.env.PI_POCKET_URL, token: process.env.PI_POCKET_TOKEN };

test("pocket tools against the v0.11.0 HTTP shapes", async (t) => {
	const requests: { method: string; path: string; body: any }[] = [];
	let busy = true;
	let waiting = false;
	let entries: any[] = [];
	let history: any[] = [];
	let approvals: any[] = [];
	let failPath = "";
	let status = 503;
	let failure: unknown = { error: `Unavailable ${TOKEN}` };
	let missing = false;
	let hang = false;
	let malformed = false;
	let subagentBusy = false;
	const pending = new Set<string>();
	const handlerErrors: unknown[] = [];
	const server = createServer(async (req, res) => {
		try {
			assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
			if (req.method !== "GET") assert.equal(req.headers["x-pocket"], "1");
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
			const url = new URL(req.url!, "http://fake");
			requests.push({ method: req.method!, path: req.url!, body });
			const json = (data: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
			if (url.pathname === failPath) {
				if (typeof failure === "string") { res.writeHead(status); res.end(failure); }
				else json(failure, status);
				return;
			}
			if (url.pathname === "/api/sessions" && req.method === "POST") {
				assert.deepEqual(Object.keys(body), ["cwd"]);
				assert.ok(body.cwd.startsWith("~/"));
				return json({ id: 42 });
			}
			if (url.pathname === "/api/c/42/configure" && req.method === "POST") {
				assert.equal(typeof body.model.provider, "string");
				assert.equal(typeof body.model.modelId, "string");
				assert.ok(!("thinking" in body));
				return json({ ok: true });
			}
			if (url.pathname === "/api/c/42/submit" && req.method === "POST") {
				assert.equal(typeof body.text, "string");
				assert.match(body.requestId, /^[\da-f-]{36}$/);
				assert.ok(body.mode === undefined || body.mode === "steer");
				return json({ submissionId: 99 });
			}
			if (url.pathname === "/api/poll" && req.method === "GET") {
				if (url.searchParams.get("close") === "1") {
					assert.ok(pending.delete(url.searchParams.get("session")!));
					return json({ ok: true });
				}
				assert.equal(url.searchParams.get("c"), "42");
				if (hang) return;
				if (malformed) { res.end("not json"); return; }
				const session = `poll-${requests.length}`;
				pending.add(session);
				// app.attach sends hello, sessions and full view in the initial poll.
				const events = [
					{ seq: 1, event: "hello", data: { user: { id: "guest", name: "Laptop", role: "guest" }, models: [], server: { home: "/home/jan" } } },
					{ seq: 2, event: "sessions", data: [{ id: 42, cwd: "/home/jan/scratch", busy, waiting, createdAt: 1, updatedAt: 1 }] },
					{ seq: 3, event: missing ? "missing" : "view", data: missing ? { conversationId: 42, message: "This session is not shared with you." } : {
						full: true, conversation: { id: 42 }, entries, order: entries.map((entry) => entry.id), live: { busy }, approvals,
						inbox: [], agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, thinkingLevel: "off", cwd: "/home/jan/scratch" }, subagents: subagentBusy ? [{ name: "worker", conversationId: 43, busy: true }] : [],
					} },
				];
				return json({ session, events });
			}
			if (url.pathname === "/api/c/42/history" && req.method === "GET") return json(history);
			throw new Error(`Unexpected route: ${req.method} ${req.url}`);
		} catch (error) {
			handlerErrors.push(error);
			res.writeHead(500); res.end(JSON.stringify({ error: "Fake server assertion failed" }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.PI_POCKET_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	process.env.PI_POCKET_TOKEN = TOKEN;
	const call = async (name: string, params: unknown, signal?: AbortSignal) => {
		const output = await tools.get(name).execute("test-call", params, signal);
		assert.ok(!JSON.stringify(output).includes(TOKEN), "token leaked in a tool result");
		return output;
	};
	const text = (output: any) => output.content[0].text as string;
	try {
		await t.test("three tools explain delegation rather than quick local work", () => {
			assert.deepEqual([...tools.keys()], ["pocket_start", "pocket_check", "pocket_send"]);
			for (const tool of tools.values()) {
				assert.match(tool.description, /laptop sleeps/);
				assert.match(tool.description, /phone/);
				assert.match(tool.description, /not quick tasks/);
			}
		});
		await t.test("start creates, configures default model, then submits task", async () => {
			const output = await call("pocket_start", { folder: "~/scratch", task: "Investigate backup" });
			assert.equal(output.isError, false);
			assert.match(text(output), /Session 42/);
			assert.ok(text(output).includes(`${process.env.PI_POCKET_URL}/s/42`));
			assert.match(text(output), /pocket_check.*Jan's approval.*phone/);
			assert.deepEqual(requests.slice(-3).map(({ path, body }) => ({ path, body })), [
				{ path: "/api/sessions", body: { cwd: "~/scratch" } },
				{ path: "/api/c/42/configure", body: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } },
				{ path: "/api/c/42/submit", body: { text: "Investigate backup", requestId: requests.at(-1)!.body.requestId } },
			]);
		});
		await t.test("custom provider/model id preserves internal slashes and maps thinking", async () => {
			await call("pocket_start", { folder: "~/work/home-ops", task: "Audit", model: "openrouter/vendor/model", thinking: "high" });
			assert.deepEqual(requests.at(-2)!.body, { model: { provider: "openrouter", modelId: "vendor/model" }, thinkingLevel: "high" });
		});
		await t.test("check working, no answer; closes poll", async () => {
			assert.match(text(await call("pocket_check", { id: "42" })), /working[\s\S]*No assistant answer yet/);
			assert.equal(pending.size, 0);
		});
		await t.test("check idle with latest text-only answer, clipped and redacted", async () => {
			busy = false;
			entries = [assistant(5, "Old answer"), { id: 6, kind: "toolResult", text: "not an answer" }, assistant(7, `${TOKEN} Latest ${"x".repeat(5000)}`)];
			const output = text(await call("pocket_check", { id: "42" }));
			assert.match(output, /idle[\s\S]*\[redacted\] Latest/);
			assert.ok(!output.includes("Old answer") && !output.includes("private reasoning"));
			assert.equal(output.split("Latest assistant answer:\n")[1].length, 4000);
		});
		await t.test("waiting for approval overrides busy and includes exposed request details", async () => {
			busy = true; waiting = true;
			approvals = [{ id: "8:call", conversationId: 42, taskId: 8, tool: "bash", subject: `rm -rf ${TOKEN}`, reason: "Destructive command", createdAt: 1 }];
			const output = text(await call("pocket_check", { id: "42" }));
			assert.match(output, /waiting for approval[\s\S]*Pending approvals[\s\S]*8:call: bash rm -rf \[redacted\]/);
			assert.ok(!requests.some((request) => request.path.startsWith("/api/approvals")));
		});
		await t.test("subagent approval and work are not reported idle", async () => {
			busy = false; approvals = [];
			assert.match(text(await call("pocket_check", { id: "42" })), /waiting for approval[\s\S]*subagent/);
			waiting = false; subagentBusy = true;
			assert.match(text(await call("pocket_check", { id: "42" })), /working/);
			subagentBusy = false;
		});
		await t.test("failed assistant surfaces readable failure, not successful idle", async () => {
			entries = [assistant(10, "", { stopReason: "error", error: `Provider failed ${TOKEN}` })];
			assert.match(text(await call("pocket_check", { id: "42" })), /failed[\s\S]*Provider failed \[redacted\]/);
		});
		await t.test("history supplies an answer after active context resets", async () => {
			entries = [assistant(14, "", { stopReason: "toolUse", blocks: [{ type: "toolCall", id: "call", name: "read", args: {} }] })];
			history = [assistant(12, "Saved answer"), ...entries];
			assert.match(text(await call("pocket_check", { id: "42" })), /idle[\s\S]*Saved answer/);
		});
		await t.test("send uses steer mode and a unique requestId", async () => {
			assert.match(text(await call("pocket_send", { id: "42", message: "Focus on yesterday" })), /submission 99/);
			const firstId = requests.at(-1)!.body.requestId;
			assert.deepEqual(requests.at(-1)!.body, { text: "Focus on yesterday", mode: "steer", requestId: firstId });
			await call("pocket_send", { id: "42", message: "Then today" });
			assert.notEqual(requests.at(-1)!.body.requestId, firstId);
		});
		await t.test("missing token prevents all requests", async () => {
			delete process.env.PI_POCKET_TOKEN;
			const count = requests.length;
			for (const [name, params] of [["pocket_start", { folder: "~/scratch", task: "Audit" }], ["pocket_check", { id: "42" }], ["pocket_send", { id: "42", message: "Hi" }]] as const) {
				const output = await call(name, params);
				assert.equal(output.isError, true);
				assert.match(text(output), /not configured: run ai-sync/);
			}
			assert.equal(requests.length, count);
			process.env.PI_POCKET_TOKEN = TOKEN;
		});
		await t.test("HTTP errors are short, redact secrets, and flag partial starts", async () => {
			failPath = "/api/c/42/configure";
			const count = requests.length;
			const output = await call("pocket_start", { folder: "~/scratch", task: "Audit" });
			assert.equal(output.isError, true);
			assert.match(text(output), /Session 42 created[\s\S]*HTTP 503: Unavailable \[redacted\]/);
			assert.equal(requests.length, count + 2, "must not submit with the wrong model");
			failPath = "/api/c/42/submit"; status = 401;
			assert.match(text(await call("pocket_send", { id: "42", message: "Hi" })), /HTTP 401/);
			failPath = "/api/poll"; status = 502; failure = `Upstream failed ${TOKEN} ${"x".repeat(1000)}`;
			const error = await call("pocket_check", { id: "42" });
			assert.equal(error.isError, true);
			assert.match(text(error), /HTTP 502: Upstream failed \[redacted\]/);
			assert.ok(text(error).length < 320);
			failPath = "";
		});
		await t.test("missing conversation closes poll and returns error", async () => {
			missing = true;
			const output = await call("pocket_check", { id: "42" });
			assert.equal(output.isError, true);
			assert.match(text(output), /not shared with you/);
			assert.equal(pending.size, 0);
			missing = false;
		});
		await t.test("malformed JSON and invalid id are readable errors", async () => {
			malformed = true;
			assert.match(text(await call("pocket_check", { id: "42" })), /Invalid JSON/);
			malformed = false;
			assert.match(text(await call("pocket_send", { id: "42/submit", message: "Hi" })), /Bad session id/);
		});
		await t.test("hung requests time out after about 15 seconds", async () => {
			hang = true;
			const start = Date.now();
			const output = await call("pocket_check", { id: "42" });
			assert.equal(output.isError, true);
			assert.match(text(output), /timeout/i);
			assert.ok(Date.now() - start >= 14_000 && Date.now() - start < 20_000);
			hang = false;
		});
		assert.deepEqual(handlerErrors, []);
		assert.equal(pending.size, 0);
	} finally {
		for (const [key, value] of [["PI_POCKET_URL", originalEnv.url], ["PI_POCKET_TOKEN", originalEnv.token]]) {
			if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
		}
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
