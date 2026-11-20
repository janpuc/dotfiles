import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./project-task.ts";

// Load the extension with a stub Pi, then settle a turn whose last prompt is `prompt`.
function settle(prompt: string, settles = 1) {
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
	assert.equal(items[0].text, "Done, 3 tests pass.");
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
