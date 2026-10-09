import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTitle } from "../../home/dot_pi/shared/extensions/profile/title.ts";

function harness(hasUI = true) {
	const handlers = new Map<string, Function>();
	const titles: string[] = [];
	registerTitle({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
	const ctx = { hasUI, cwd: "/tmp/title-project", ui: { setTitle: (title: string) => titles.push(title) } };
	return { titles, emit: (event: string) => handlers.get(event)!({}, ctx) };
}

test("title frames advance, wrap, then settle to the project with no remaining timer", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const h = harness();
	h.emit("session_start");
	assert.deepEqual(h.titles, ["✓ title-project"]);
	h.emit("agent_start");
	t.mock.timers.tick(100);
	assert.deepEqual(h.titles.slice(-2), ["⠋ title-project", "⠙ title-project"]);
	t.mock.timers.tick(900);
	assert.equal(h.titles.at(-1), "⠋ title-project");
	h.emit("agent_settled");
	assert.equal(h.titles.at(-1), "✓ title-project");
	const count = h.titles.length;
	t.mock.timers.tick(1000);
	assert.equal(h.titles.length, count);
	// Checking clearInterval as well as output catches a silent leaked timer.
	const clear = t.mock.method(globalThis, "clearInterval");
	h.emit("session_shutdown");
	assert.equal(clear.mock.callCount(), 0);
});

test("restart, session start and shutdown each dispose the active title timer", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const clear = t.mock.method(globalThis, "clearInterval");
	const h = harness();
	h.emit("agent_start");
	h.emit("agent_start");
	assert.equal(clear.mock.callCount(), 1);
	t.mock.timers.tick(100);
	assert.deepEqual(h.titles, ["⠋ title-project", "⠋ title-project", "⠙ title-project"]);
	h.emit("session_start");
	assert.equal(clear.mock.callCount(), 2);
	h.emit("agent_start");
	h.emit("session_shutdown");
	assert.equal(clear.mock.callCount(), 3);
	const count = h.titles.length;
	t.mock.timers.tick(1000);
	assert.equal(h.titles.length, count);
});

test("non-UI sessions never allocate a title timer", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const interval = t.mock.method(globalThis, "setInterval");
	const h = harness(false);
	for (const event of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) h.emit(event);
	t.mock.timers.tick(1000);
	assert.equal(interval.mock.callCount(), 0);
	assert.deepEqual(h.titles, []);
});
