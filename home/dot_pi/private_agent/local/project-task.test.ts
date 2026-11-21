import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./project-task.ts";

// Load the extension with a stub Pi, then settle a turn whose last prompt is `prompt`.
function settle(prompt: string, settles = 1, work: any[] = []) {
	const home = fs.mkdtempSync(join(tmpdir(), "project-task-test-"));
	const workspace = join(home, "Development/home");
	const state = join(workspace, ".agent/tasks/speakers");
	fs.mkdirSync(state, { recursive: true });
	const saved = { ...process.env };
	Object.assign(process.env, { HOME: home, PI_TASK: "speakers", PI_PROJECT: "home", PI_TASK_STATE_DIR: state, PI_TASK_DIR: join(workspace, "tasks/speakers"), PI_PROJECT_DIR: workspace });
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
	const handlers: Record<string, Function> = {};
	try {
		extension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, sendUserMessage: () => {} } as any);
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: prompt }] } },
			...work.map((message, i) => ({ type: "message", id: `w${i}`, message })),
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Done, 3 tests pass." }] } },
		];
		const ctx: any = { isIdle: () => true, hasPendingMessages: () => false, mode: "print", hasUI: false, sessionManager: { getBranch: () => branch } };
		for (let i = 0; i < settles; i++) handlers.agent_settled({}, ctx);
		const inbox = join(workspace, ".agent/inbox");
		const items = fs.existsSync(inbox) ? fs.readdirSync(inbox).map((name) => JSON.parse(fs.readFileSync(join(inbox, name), "utf8"))) : [];
		return { items, waiting: fs.existsSync(join(home, ".local/state/agents/attention/home--speakers.json")) };
	} finally {
		process.env = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("a turn the coordinator started reports once to the project inbox", () => {
	const { items, waiting } = settle("Message for task speakers from the home coordinator, sent with agent task send:\n\nFix it.", 2);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "report");
	assert.equal(items[0].from, "home");
	assert.equal(items[0].to, "home");
	assert.equal(items[0].task, "speakers");
	assert.equal(items[0].status, "new");
	assert.equal(items[0].text, "Done, 3 tests pass.\n\nTurn record from the session log: no tool calls in this turn.");
	assert.match(items[0].id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
	assert.equal(waiting, false);
});

test("the opening brief reports too", () => {
	assert.equal(settle("Work on task speakers. Read BRIEF.md and STATE.md.").items.length, 1);
});

test("a turn Jan started stays in the task and lights the waiting pill", () => {
	const { items, waiting } = settle("Make the slot 2 mm wider");
	assert.equal(items.length, 0);
	assert.equal(waiting, true);
});

// Offer a close, then settle a reply that never emits TASK_CLOSE_READY.
async function pausedClose(withResult: boolean) {
	const home = fs.mkdtempSync(join(tmpdir(), "project-task-test-"));
	const workspace = join(home, "Development/home");
	const state = join(workspace, ".agent/tasks/speakers");
	const taskDir = join(workspace, "tasks/speakers");
	fs.mkdirSync(state, { recursive: true });
	fs.mkdirSync(taskDir, { recursive: true });
	if (withResult) fs.writeFileSync(join(taskDir, "RESULT.md"), "# Result\n");
	fs.writeFileSync(join(state, "close-requested"), "20261120T120000-abcdef\n");
	const saved = { ...process.env };
	Object.assign(process.env, { HOME: home, PI_TASK: "speakers", PI_PROJECT: "home", PI_TASK_STATE_DIR: state, PI_TASK_DIR: taskDir, PI_PROJECT_DIR: workspace });
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
	const handlers: Record<string, Function> = {};
	const sent: string[] = [];
	const notes: string[] = [];
	try {
		extension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, sendUserMessage: (m: string) => { sent.push(m); } } as any);
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Close task speakers now." }] } },
			{ type: "message", id: "a1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The task is already complete." }] } },
		];
		const ctx: any = { isIdle: () => true, hasPendingMessages: () => false, mode: "tui", hasUI: true, ui: { notify: (m: string) => notes.push(m) }, shutdown: () => {}, sessionManager: { getBranch: () => branch } };
		handlers.session_start({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5200));
		await handlers.agent_settled({}, ctx);
		handlers.session_shutdown();
		const inbox = join(workspace, ".agent/inbox");
		const items = fs.existsSync(inbox) ? fs.readdirSync(inbox).map((name) => JSON.parse(fs.readFileSync(join(inbox, name), "utf8"))) : [];
		return { sent, items };
	} finally {
		process.env = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("a close that ends without the marker reports to the coordinator", async () => {
	const { sent, items } = await pausedClose(false);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /does not close it/);
	assert.match(sent[0], /RESULT\.md does not exist yet/);
	assert.match(sent[0], /Do not rewrite deliverables/);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "report");
	assert.match(items[0].text, /^Close of task speakers paused: the turn ended without TASK_CLOSE_READY\./);
	assert.match(items[0].text, /agent task close home speakers again/);
	assert.match(items[0].text, /The task is already complete\.\n\nTurn record from the session log: no tool calls in this turn\.$/);
});

test("the close message says when RESULT.md is already written", async () => {
	const { sent } = await pausedClose(true);
	assert.match(sent[0], /RESULT\.md already exists\. Check it is accurate/);
});

test("a steering message reaches a busy turn, a plain one waits for idle", async () => {
	const home = fs.mkdtempSync(join(tmpdir(), "project-task-test-"));
	const workspace = join(home, "Development/home");
	const state = join(workspace, ".agent/tasks/speakers");
	const taskDir = join(workspace, "tasks/speakers");
	fs.mkdirSync(join(state, "messages/steer"), { recursive: true });
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(join(state, "messages/20261120T120000.md"), "Plain\n");
	fs.writeFileSync(join(state, "messages/steer/20261120T120001.md"), "Stop, wrong file\n");
	const saved = { ...process.env };
	Object.assign(process.env, { HOME: home, PI_TASK: "speakers", PI_PROJECT: "home", PI_TASK_STATE_DIR: state, PI_TASK_DIR: taskDir, PI_PROJECT_DIR: workspace });
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
	const handlers: Record<string, Function> = {};
	const sent: [string, any][] = [];
	try {
		extension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, sendUserMessage: (m: string, o: any) => { sent.push([m, o]); } } as any);
		const ctx: any = { isIdle: () => false, hasPendingMessages: () => true, mode: "tui", hasUI: true, ui: { notify: () => {} }, shutdown: () => {}, sessionManager: { getBranch: () => [] } };
		handlers.session_start({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5200));
		handlers.session_shutdown();
		assert.equal(sent.length, 1);
		assert.match(sent[0][0], /^Message for task speakers from the home coordinator, sent with agent task send --steer during your turn/);
		assert.match(sent[0][0], /Stop, wrong file$/);
		assert.deepEqual(sent[0][1], { deliverAs: "steer" });
		assert.ok(fs.existsSync(join(state, "messages/20261120T120000.md")));
		assert.ok(fs.existsSync(join(state, "messages/steer/delivered/20261120T120001.md")));
	} finally {
		process.env = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("a report ends with the tool calls, failures and files the session log shows", () => {
	const work = [
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "/w/bad.md" } }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "/w/STATE.md" } }] },
		{ role: "toolResult", toolCallId: "c1", toolName: "write", isError: true },
		{ role: "toolResult", toolCallId: "c2", toolName: "edit", isError: false },
		{ role: "assistant", content: [{ type: "toolCall", id: "c3", name: "codemode", arguments: { code: "x" } }] },
		{ role: "toolResult", toolCallId: "c3", toolName: "codemode", isError: false, nestedCalls: { calls: [{ name: "write", status: "ok", arguments: { path: "/w/IDEAS.md" } }, { name: "write", status: "error", arguments: { path: "/w/no.md" } }] } },
	];
	const { items } = settle("Message for task speakers from the home coordinator, sent with agent task send:\n\nFix it.", 1, work);
	assert.match(items[0].text, /\n\nTurn record from the session log: 3 tool calls, 1 failed\. Files written or edited: \/w\/STATE\.md, \/w\/IDEAS\.md\.$/);
});
