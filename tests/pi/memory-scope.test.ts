import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryToolBlock } from "../../home/dot_pi/shared/extensions/profile/memory-scope.ts";

test("memory tools stay inside the profile's scope", () => {
	const home = { home: "personal/jan" };
	assert.equal(memoryToolBlock("work", "memory_recall", {}, home), undefined);
	assert.equal(memoryToolBlock("work", "memory_get", { namespace: "work/api" }, home), undefined);
	assert.equal(memoryToolBlock("work", "memory_get", { namespace: "personal/jan" }, home), undefined, "home overlay is readable");
	assert.match(memoryToolBlock("work", "memory_update", { namespace: "personal/jan" }, home)!, /only write work/);
	assert.match(memoryToolBlock("work", "memory_get", { namespace: "homelab/home-ops" }, home)!, /only read work/);
	assert.match(memoryToolBlock("work", "memory_remember", { visibility: "personal" }, home)!, /visibility personal/);
	assert.equal(memoryToolBlock("work", "memory_remember", { visibility: "project" }, home), undefined);
	assert.match(memoryToolBlock("personal", "memory_list", { namespace: "work/api" }, home)!, /cannot access Work/);
	assert.equal(memoryToolBlock("personal", "memory_remember", { visibility: "personal" }, home), undefined);
	assert.match(memoryToolBlock("personal", "memory_recall", {}, { ...home, memoryOff: "PI_MEMINI=off" })!, /memory is off/);
	assert.equal(memoryToolBlock("work", "read", { namespace: "homelab/x" }, home), undefined);
});

// --- notifications -------------------------------------------------------------------------------

import { duration, notificationSequence, notifyAfterMs } from "../../home/dot_pi/shared/extensions/profile/notify.ts";

test("notifications: OSC 777 by default, OSC 99 in Kitty, text cannot break the sequence", () => {
	assert.equal(notificationSequence("Pi · app", "Done in 1m 02s", {}), "\x1b]777;notify;Pi · app;Done in 1m 02s\x07");
	assert.match(notificationSequence("Pi", "x", { KITTY_WINDOW_ID: "1" }), /^\x1b\]99;/);
	assert.equal(notificationSequence("a;b", "c\x07d\x1b", {}), "\x1b]777;notify;a b;c d \x07");
	assert.equal(duration(42_000), "42s");
	assert.equal(duration(62_000), "1m 02s");
	assert.equal(notifyAfterMs({}), 30_000);
	assert.equal(notifyAfterMs({ PI_NOTIFY_AFTER: "0" }), 0);
	assert.equal(notifyAfterMs({ PI_NOTIFY_AFTER: "x" }), 30_000);
});
