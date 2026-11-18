import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { rotationDue, rotationThresholds } from "./project-rotate-rules.ts";

const defaults = { sizeMB: 100, compactions: 5, days: 30 };
const now = 31 * 86400000;
const stats = { bytes: 0, compactions: 0, startedAt: now };

test("below all rotation thresholds", () => {
	assert.equal(rotationDue(defaults, stats, now), false);
});
for (const [name, value] of Object.entries({
	size: { ...stats, bytes: 100 * 1024 * 1024 },
	compactions: { ...stats, compactions: 5 },
	age: { ...stats, startedAt: now - 30 * 86400000 },
})) test(`rotation at ${name} threshold`, () => assert.equal(rotationDue(defaults, value, now), true));

test("project overrides merge independently", () => {
	const thresholds = rotationThresholds(defaults, { compactions: 2 });
	assert.deepEqual(thresholds, { ...defaults, compactions: 2 });
	assert.equal(rotationDue(thresholds, { ...stats, compactions: 2 }, now), true);
	assert.deepEqual(defaults, { sizeMB: 100, compactions: 5, days: 30 });
});

test("invalid thresholds fail rather than silently disabling rotation", () => {
	for (const days of [0, -1, NaN, Infinity]) {
		assert.throws(() => rotationThresholds(defaults, { days }));
	}
});

// Pi supplies these helpers at runtime. Keep lifecycle tests offline and dependency-free.
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") return {
			url: "data:text/javascript," + encodeURIComponent(
				"export const convertToLlm = messages => messages; export const serializeConversation = JSON.stringify;"),
			shortCircuit: true,
		};
		return next(specifier, context);
	},
});
let rotate: typeof import("./project-rotate.ts").default;
try { rotate = (await import("./project-rotate.ts")).default; }
finally { hooks.deregister(); }

for (const failure of ["none", "write", "rename", "shutdown"]) test(`rotation lifecycle, failure=${failure}`, async (t) => {
	const failRequest = failure !== "none";
	const folder = fs.mkdtempSync(join(tmpdir(), "project-rotate-test-"));
	const state = join(folder, ".agent");
	fs.mkdirSync(state);
	fs.mkdirSync(join(folder, "notes"));
	fs.writeFileSync(join(folder, "notes/STATE.md"), "checkpoint");
	fs.writeFileSync(join(state, "generation"), "1\n");
	const keys = ["PI_PROJECT", "PI_PROJECT_DIR", "PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"];
	const saved = keys.map((key) => process.env[key]);
	process.env.PI_PROJECT = "home";
	process.env.PI_PROJECT_DIR = folder;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
	const handlers: Record<string, any> = {};
	let command: any, shutdowns = 0, routines = 0, summaries = 0;
	const notices: string[] = [];
	const read = fs.readFileSync, write = fs.writeFileSync, rename = fs.renameSync;
	let fail = failRequest;
	t.mock.method(fs, "readFileSync", (path: any, ...args: any[]) => {
		if (String(path).endsWith("/.config/agents/projects.json")) return JSON.stringify({
			defaults: { rotation: defaults }, projects: { home: {} },
		});
		return (read as any)(path, ...args);
	});
	t.mock.method(fs, "writeFileSync", (path: any, ...args: any[]) => {
		if (fail && failure === "write" && path === join(state, "rotate-requested.tmp")) throw new Error("injected request write failure");
		return (write as any)(path, ...args);
	});
	t.mock.method(fs, "renameSync", (from: any, to: any) => {
		if (fail && failure === "rename" && to === join(state, "rotate-requested")) throw new Error("injected request write failure");
		return rename(from, to);
	});
	syncBuiltinESMExports();
	const ctx: any = {
		mode: "tui", hasUI: true, model: {}, isIdle: () => true, hasPendingMessages: () => false,
		waitForIdle: async () => {}, shutdown: () => {
			if (fail && failure === "shutdown") throw new Error("injected shutdown failure");
			shutdowns++;
		},
		ui: { setStatus: () => {}, notify: (text: string) => notices.push(text) },
		sessionManager: {
			getSessionFile: () => undefined, getEntries: () => [],
			getHeader: () => ({ timestamp: new Date().toISOString() }), getLeafId: () => "leaf",
			buildContextEntries: () => [], getBranch: () => [{ type: "message", message: {
				role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ROTATION_READY" }],
			} }],
		},
		modelRegistry: { complete: async () => ({ stopReason: "stop", content: [
			{ type: "text", text: `handoff ${++summaries}` },
		] }) },
	};
	try {
		rotate({ on: (name: string, handler: any) => { handlers[name] = handler; },
			registerCommand: (_: string, value: any) => { command = value.handler; },
			sendUserMessage: () => { routines++; },
		} as any);
		handlers.session_start({}, ctx);
		await command("continue", ctx);
		assert.equal(routines, 1);
		await handlers.agent_settled({ aborted: false }, ctx);
		assert.equal(fs.readFileSync(join(state, "generation"), "utf8"), "1\n");
		assert.equal(fs.readFileSync(join(state, "handoff-2.md"), "utf8"), "handoff 1\n");
		if (failRequest) {
			assert.equal(shutdowns, 0);
			assert.equal(fs.existsSync(join(state, "rotate-requested")), false);
			assert.deepEqual(fs.readdirSync(state).sort(), ["generation", "handoff-2.md"]);
			assert.match(notices[0], /current session kept.*injected/);
			fail = false;
			await command("retry", ctx);
			await handlers.agent_settled({ aborted: false }, ctx);
			assert.equal(fs.readFileSync(join(state, "handoff-2.md"), "utf8"), "handoff 2\n");
		}
		assert.equal(fs.readFileSync(join(state, "generation"), "utf8"), "1\n");
		assert.equal(fs.readFileSync(join(state, "rotate-requested"), "utf8"), "2\n");
		assert.equal(shutdowns, 1);
	} finally {
		handlers.session_shutdown?.();
		t.mock.restoreAll();
		syncBuiltinESMExports();
		keys.forEach((key, i) => {
			if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
		});
		fs.rmSync(folder, { recursive: true, force: true });
	}
});
