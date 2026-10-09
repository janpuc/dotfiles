// Real Pi loader/CLI/gateway, with a synthetic parent and fake terminal dialogs. No live history.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workers from "../../home/dot_pi/shared/extensions/subagent/index.ts";
import { WorkerPool } from "../../home/dot_pi/shared/extensions/subagent/pool.ts";
export default function stage2bTests(pi: ExtensionAPI) {
	pi.registerCommand("test-worker-stage2b", { description: "Offline stage2b assertions", handler: async (_args, real) => {
		const handlers = new Map<string, any[]>(), tools = new Map<string, any>(), commands = new Map<string, any>(), notices: string[] = [];
		const fake: any = { on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerTool(t: any) { tools.set(t.name, t); },
			registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, sendMessage() {} };
		const parent = SessionManager.inMemory(real.cwd);
		const first = parent.appendMessage({ role: "user", content: "FORK_PARENT_OLD", timestamp: Date.now() });
		parent.appendCustomMessageEntry("memini-recall", "FORBIDDEN_MEMORY_SENTINEL", false);
		parent.appendMessage({ role: "system", content: "FORBIDDEN_SYSTEM_SENTINEL", timestamp: Date.now() });
		parent.appendCompaction("FORBIDDEN_SUMMARY_SENTINEL", first, 10);
		parent.appendContextEdit(first, { content: "FORK_PARENT_SENTINEL" });
		let confirm = false, duringConfirm: (() => void) | undefined;
		const ctx: any = { ...real, mode: "tui", hasUI: true, waitForIdle: async () => {}, sessionManager: parent,
			ui: { ...real.ui, setWidget() {}, setEditorComponent() {}, setTitle() {}, onTerminalInput() { return () => {}; }, notify(value: string) { notices.push(value); },
				confirm: async (_title: string, body: string) => { assert.match(body, /Working files only/); duringConfirm?.(); return confirm; },
				custom: async (factory: any) => { let reviewed: any; const tui = { terminal: { rows: 12 }, requestRender() {} }; const view = factory(tui, real.ui.theme, {}, (value: any) => { reviewed = value; }); view.render(80); view.handleInput("\x1b[F"); view.render(80); view.handleInput("\r"); view.dispose?.(); return reviewed; } } };
		const pool = new WorkerPool(); workers(fake, undefined, pool);
		const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
		const call = (params: any) => tools.get("worker").execute("test", params, undefined, undefined, ctx);
		const list = async () => (await call({ action: "status" })).details.jobs;
		const settle = async (id: string) => { for (let i = 0; i < 200; i++) { const job = (await list()).find((j: any) => j.id === id); if (job.state !== "running") { assert.equal(job.state, "succeeded", (await call({ action: "result", id })).content[0].text); return job; } await new Promise(done => setTimeout(done, 50)); } throw new Error("stage2b worker did not settle"); };
		const source = (id: string) => readFileSync(join(getAgentDir(), "workers", parent.getSessionId(), `${id}.jsonl`), "utf8");
		const model = "litellm/opencode-go/deepseek-v4.1-flash";
		const rules = (value: any) => writeFileSync(join(process.env.PI_TEST_GATEWAY_DIR!, "gateway.json"), JSON.stringify(value));
		await emit("session_start");
		try {
			const base = { action: "start", agent: "worker", model, task: "PI-SMOKE bounded source inspection", tools: [] };
			const plain = await call(base); await settle(plain.details.id); assert.ok(!source(plain.details.id).includes("FORK_PARENT_SENTINEL"));
			const forked = await call({ ...base, forkContext: true }); await settle(forked.details.id);
			assert.match(source(forked.details.id), /FORK_PARENT_SENTINEL/);
			for (const denied of ["FORK_PARENT_OLD", "FORBIDDEN_MEMORY_SENTINEL", "FORBIDDEN_SYSTEM_SENTINEL", "FORBIDDEN_SUMMARY_SENTINEL"]) assert.ok(!source(forked.details.id).includes(denied));
			parent.appendMessage({ role: "user", content: "FORK_PARENT_LATER", timestamp: Date.now() });
			await call({ action: "resume", id: forked.details.id, task: "PI-SMOKE own fork resume" }); await settle(forked.details.id); assert.ok(!source(forked.details.id).includes("FORK_PARENT_LATER"));
			await assert.rejects(call({ ...base, isolation: "worktree", tools: ["bash"], files: ["a.txt"] }), /no bash/);
			rules({ "opencode-go/deepseek-v4.1-flash": { script: [{ tool: "edit", args: { path: "a.txt", oldText: "base a\n", newText: "isolated a\n" } }] },
				"mock/tools": { script: [{ tool: "edit", args: { path: "b.txt", oldText: "base b\n", newText: "isolated b\n" } }] } });
			const a = await call({ ...base, isolation: "worktree", tools: ["read", "edit"], files: ["a.txt"] });
			const b = await call({ ...base, model: "litellm/mock/tools", isolation: "worktree", tools: ["read", "edit"], files: ["b.txt"] });
			assert.equal(pool.hasWriter, false); assert.equal(await handlers.get("tool_call")![0]({ toolName: "edit" }), undefined);
			const wa = await settle(a.details.id), wb = await settle(b.details.id);
			assert.equal(readFileSync(join(real.cwd, "a.txt"), "utf8"), "base a\n"); assert.equal(readFileSync(join(real.cwd, "b.txt"), "utf8"), "base b\n");
			assert.equal(readFileSync(join(wa.checkout, "a.txt"), "utf8"), "isolated a\n"); assert.equal(readFileSync(join(wb.checkout, "b.txt"), "utf8"), "isolated b\n");
			assert.equal(JSON.parse(source(a.details.id).split("\n")[0]).cwd, wa.checkout);
			const index = readFileSync(join(real.cwd, ".git", "index"));
			await commands.get("tasks").handler(`merge ${a.details.id}`, ctx); assert.equal(readFileSync(join(real.cwd, "a.txt"), "utf8"), "base a\n");
			confirm = true; duringConfirm = () => writeFileSync(join(real.cwd, "a.txt"), "racing parent\n");
			await commands.get("tasks").handler(`merge ${a.details.id}`, ctx); assert.ok(notices.some(s => s.includes("Parent changed"))); assert.equal(readFileSync(join(real.cwd, "a.txt"), "utf8"), "racing parent\n");
			duringConfirm = undefined; writeFileSync(join(real.cwd, "a.txt"), "base a\n");
			await commands.get("tasks").handler(`merge ${a.details.id}`, ctx); await commands.get("tasks").handler(`merge ${b.details.id}`, ctx);
			assert.equal(readFileSync(join(real.cwd, "a.txt"), "utf8"), "isolated a\n"); assert.equal(readFileSync(join(real.cwd, "b.txt"), "utf8"), "isolated b\n"); assert.deepEqual(readFileSync(join(real.cwd, ".git", "index")), index);
			const count = notices.length; await commands.get("tasks").handler(`merge ${a.details.id}`, ctx); assert.equal(notices.length, count);
			rules({ "opencode-go/deepseek-v4.1-flash": { script: [{ tool: "edit", args: { path: "a.txt", oldText: "isolated a\n", newText: "shared worker a\n" } }] } });
			const shared = await call({ ...base, tools: ["edit"], files: ["a.txt"] }); await settle(shared.details.id); assert.equal(readFileSync(join(real.cwd, "a.txt"), "utf8"), "shared worker a\n");
			rules({}); await commands.get("subtask").handler("PI-SMOKE selected-model read-only fork", ctx);
			const shortcut = (await list()).at(-1); assert.equal(shortcut.model, `${real.model!.provider}/${real.model!.id}`); await settle(shortcut.id);
			await emit("session_shutdown"); await emit("session_start"); const restored = await list(); assert.ok(restored.some((j: any) => j.id === a.details.id && j.checkout === wa.checkout));
			console.error("WORKER-STAGE2B-PASS");
		} finally { await emit("session_shutdown"); rules({}); }
	} });
}
