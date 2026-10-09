import assert from "node:assert/strict";
import { test } from "node:test";
import { quietMemoryAPI, quietMessage } from "../../home/dot_pi/shared/extensions/memory/quiet.ts";

test("quiet automatic memory preserves content/details and hides only routine messages", () => {
	for (const customType of ["memini-recall", "memini-briefing"]) {
		const message = { customType, display: true, content: "full untrusted context", details: { dedupe: { ids: ["1"] } } };
		const quiet = quietMessage(message);
		assert.equal(quiet.display, false); assert.equal(quiet.content, message.content); assert.equal(quiet.details, message.details);
		assert.equal(message.display, true);
	}
	const degraded = { customType: "memini-recall", display: true, details: { degraded: true } };
	assert.equal(quietMessage(degraded), degraded);
	const error = { customType: "memini-briefing", display: true, details: { error: "scope conflict" } };
	assert.equal(quietMessage(error), error);
	const explicit = { customType: "memini-status", display: true };
	assert.equal(quietMessage(explicit), explicit);
});

test("adapter quiets before emission, retains send options and unsubscribe behavior", async () => {
	let sent: any[], handler: any; const unsubscribe = () => {};
	const api = { sendMessage: (...args: any[]) => { sent = args; }, on: (_event: string, h: any) => { handler = h; return unsubscribe; }, other: { stable: true } };
	const quiet = quietMemoryAPI(api);
	const options = { triggerTurn: false, deliverAs: "steer" };
	quiet.sendMessage({ customType: "memini-briefing", content: "model payload", display: true }, options);
	assert.equal(sent![0].display, false); assert.equal(sent![0].content, "model payload"); assert.equal(sent![1], options);
	assert.equal(quiet.on("before_agent_start", async () => ({ message: { customType: "memini-recall", content: "full", display: true }, systemPrompt: "unchanged" })), unsubscribe);
	assert.deepEqual(await handler(), { message: { customType: "memini-recall", content: "full", display: false }, systemPrompt: "unchanged" });
	assert.equal(quiet.other, api.other);
	let runs = 0;
	quiet.on("session_end", () => ++runs);
	(globalThis as any)[Symbol.for("pi-profile.memory-block")] = "cross-scope";
	const skipped = handler(); quiet.sendMessage({ customType: "blocked" }); const dropped = sent![0].customType;
	(globalThis as any)[Symbol.for("pi-profile.memory-block")] = undefined;
	const resumed = await handler(); quiet.sendMessage({ customType: "resumed" });
	assert.deepEqual([skipped, dropped, resumed, runs, sent![0].customType], [undefined, "memini-briefing", 1, 1, "resumed"]);
	const plain = () => {};
	quiet.on("session_start", plain); assert.equal(await handler(), undefined);
	quiet.on("before_agent_start", () => { throw new Error("real memory failure"); });
	await assert.rejects(handler(), /real memory failure/);
});
