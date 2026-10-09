// Loaded by the real Pi extension loader; fake tasks exercise background ownership without model calls.
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workers from "../../home/dot_pi/shared/extensions/subagent/index.ts";
import { WorkerPool } from "../../home/dot_pi/shared/extensions/subagent/pool.ts";
import { registerAdvisor } from "../../home/dot_pi/shared/extensions/profile/advisor.ts";
import type { WorkerRequest, WorkerResult } from "../../home/dot_pi/shared/extensions/subagent/runner.ts";

export default function lifecycleTests(pi: ExtensionAPI) {
	pi.registerCommand("test-worker-lifecycle", {
		description: "Offline lifecycle assertions",
		handler: async (_args, realCtx) => {
			const handlers = new Map<string, any[]>(), tools = new Map<string, any>(), messages: any[] = [];
			const pending: { request: WorkerRequest; finish: (result: WorkerResult) => void }[] = [];
			const fake: any = {
				on: (name: string, fn: any) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
				registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, registerMessageRenderer: () => {},
				sendMessage: (message: any, options: any) => messages.push({ message, options }),
			};
			const result = (request: WorkerRequest, state: WorkerResult["state"] = "succeeded"): WorkerResult =>
				({ state, output: "verified evidence", model: request.model, tools: request.tools, turns: 1 });
			const pool = new WorkerPool();
			const run = (request: WorkerRequest) => new Promise<WorkerResult>((finish) => {
				pending.push({ request, finish });
				request.signal?.addEventListener("abort", () => finish(result(request, request.task.startsWith("settled") ? "succeeded" : "cancelled")), { once: true });
				if (request.task.startsWith("immediate")) finish(result(request));
			});
			workers(fake, run, pool);
			registerAdvisor(fake, { blocked: () => undefined }, pool, run);
			assert.equal(tools.get("worker").executionMode, "sequential");
			assert.equal(tools.get("subagent").executionMode, "sequential");
			assert.equal(tools.get("advisor").executionMode, "sequential");
			const emit = async (name: string, event = {}, context?: any) => { for (const handler of handlers.get(name) ?? []) await handler(event,context); };
			const ctx: any = { ...realCtx, mode: "tui", modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } };
			const call = (params: any, context = ctx) => tools.get("worker").execute("test", params, undefined, undefined, context);
			await emit("session_start");
			const start = { action: "start", agent: "worker", task: "bounded read-only task", model: "litellm/mock/tools", tools: ["read"] };
			assert.match((await call(start)).content[0].text, /Started w1/);
			assert.match((await call(start)).content[0].text, /Started w2/);
			await assert.rejects(call(start), /At most 2/);
			const advice = () => tools.get("advisor").execute("advice", { question: "bounded independent review" }, undefined, undefined, ctx);
			await assert.rejects(advice(), /At most 2/); // Advisors share worker admission slots.
			pending[0].finish(result(pending[0].request));
			await new Promise((done) => setTimeout(done, 0));
			assert.equal(messages.length, 1); assert.equal(messages[0].options.deliverAs, "followUp"); assert.equal(messages[0].options.triggerTurn, true);
			await call({ action: "cancel", id: "w2" }); assert.equal(pending[1].request.signal?.aborted, true);
			assert.equal(messages.length, 1);
			await call(start); await emit("session_tree"); assert.equal(pending[2].request.signal?.aborted, true); assert.equal(messages.length, 1);
			await assert.rejects(call({ ...start, tools: ["write"] }), /owned file paths/);
			await call({ ...start, tools: ["write"], files: ["owned.ts"] });
			assert.equal((await handlers.get("tool_call")![0]({ toolName: "edit" })).block, true);
			assert.equal(await handlers.get("tool_call")![0]({ toolName: "read" }), undefined);
			await assert.rejects(call({ ...start, tools: ["write"], files: ["other.ts"] }), /Only one editing/);
			await emit("session_shutdown"); assert.equal(pending[3].request.signal?.aborted, true);
			await assert.rejects(call(start), /not active/);
			await emit("session_start");
			assert.equal((await call({ ...start, task: "immediate task" }, { ...ctx, mode: "print" })).content[0].text, "verified evidence");
			assert.equal(messages.length, 1); // No background delivery in one-shot mode.
			const before = pending.length;
			await assert.rejects(tools.get("subagent").execute("parallel", { tasks: [
				{ agent: "worker", task: "bounded sibling", model: "litellm/mock/tools", tools: ["read"] },
				{ agent: "not-a-role", task: "invalid second sibling", model: "litellm/mock/tools", tools: ["read"] },
			] }, undefined, undefined, ctx), /Unknown trusted user role/);
			// A sibling may be cancelled before its deferred runner even starts; none survives.
			assert.equal(pool.count, 0);
			assert.equal(pending.length === before || pending[before].request.signal?.aborted, true);
			const settled = await call({ ...start, task: "settled but shutting down" });
			await call({ action: "cancel", id: settled.details.id });
			assert.equal(messages.length, 1); // Preserve evidence but never deliver cancelled assignments.
			const concurrent = [advice(), advice()]; const collected = Promise.allSettled(concurrent);
			await assert.rejects(advice(), /At most 2/);
			assert.equal(pool.count, 2);
			await emit("session_before_switch"); await collected;
			assert.equal(pool.count, 0); // Navigation owns advisor cancellation too.
			// Busy parent: completions wait for settle; a result already read never wakes Opus again.
			const tick = () => new Promise((done) => setTimeout(done, 0));
			const delivered = messages.length;
			await emit("agent_start");
			const read = await call({ ...start, task: "immediate busy result read in turn" });
			const unread = await call({ ...start, task: "immediate busy result left unread" });
			await tick();
			assert.equal(messages.length, delivered);
			await call({ action: "result", id: read.details.id });
			await emit("agent_settled", { aborted: false });
			assert.equal(messages.length, delivered + 1);
			assert.match(messages.at(-1).message.content, new RegExp(`^Worker ${unread.details.id} `));
			assert.equal(messages.at(-1).options.triggerTurn, true);
			// Escape-aborted parent: show the result without starting another turn.
			await emit("agent_start");
			await call({ ...start, task: "immediate result after escape" });
			await tick();
			await emit("agent_settled", { aborted: true });
			assert.equal(messages.length, delivered + 2);
			assert.equal(messages.at(-1).options.triggerTurn, false);
			// Reload/reopen keeps session-scoped identities, never auto-delivers old results.
			const stored = await call({ ...start, task: "immediate durable result" }); await tick();
			const oldId = stored.details.id, oldSequence = Number(oldId.slice(1));
			await emit("session_shutdown"); const beforeReloadDelivery = messages.length;
			await emit("session_start");
			const restored = await call({action:"status"});
			assert.ok(restored.details.jobs.some((j:any)=>j.id===oldId));
			assert.equal(messages.length,beforeReloadDelivery);
			const resumed = await call({action:"resume",id:oldId,task:"immediate follow-up with unchanged tools"});
			assert.equal(resumed.details.id,oldId); await tick();
			assert.equal(pending.at(-1)!.request.model,start.model);
			assert.deepEqual(pending.at(-1)!.request.tools,start.tools);
			assert.match(pending.at(-1)!.request.sessionFile!,new RegExp(`${oldId}\\.jsonl$`));
			const fresh = await call({...start,task:"immediate fresh worker"});
			assert.ok(Number(fresh.details.id.slice(1))>oldSequence); await tick();
			await emit("session_shutdown");
			// Exercise real-context startup and the raw chord; advisors share stop-all.
			let key:any;
			const uiCtx={...ctx,ui:{...ctx.ui,notify(){},setWidget(){},setEditorComponent(){},setTitle(){},onTerminalInput(fn:any){key=fn;return()=>{key=undefined}}}};
			await emit("session_start",{},uiCtx);
			const chordJob=await call({...start,task:"bounded chord worker"},uiCtx);
			const chordAdvice=advice().catch(()=>{});await tick();assert.equal(pool.count,2);
			assert.equal(key("\x18").consume,true);assert.equal(key("\x0b").consume,true);
			await chordAdvice;await tick();assert.equal(pool.count,0);
			assert.equal((await call({action:"status"})).details.jobs.find((j:any)=>j.id===chordJob.details.id).state,"cancelled");
			await emit("session_shutdown");
			console.error("WORKER-LIFECYCLE-PASS");
		},
	});
}
