// Two actual isolated CLI runs on one native worker session; fresh bootstrap on both.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkerStore, type WorkerRecord } from "../../home/dot_pi/shared/extensions/subagent/store.ts";
import { runWorker, type WorkerControl, type WorkerRequest } from "../../home/dot_pi/shared/extensions/subagent/runner.ts";
import { ownIdentity, processStart } from "../../home/dot_pi/shared/extensions/profile/session-lock.ts";
export default function durableTests(pi: ExtensionAPI) {
	pi.registerCommand("test-worker-durable",{description:"Offline native worker-session assertions",handler:async(_args,ctx)=>{
		const root=join(getAgentDir(),"workers"), parent=ctx.sessionManager.getSessionId();
		let store=new WorkerStore(root,parent,ctx.cwd,process.env.AI_PROFILE==="work"?"work":"personal");
		const record:WorkerRecord={version:1,id:"w1",task:{agent:"worker",task:"PI-SMOKE WORKER_OWN_HISTORY",cwd:ctx.cwd,model:"litellm/opencode-go/deepseek-v4.1-flash",thinking:"low",tools:[]},systemPrompt:"A bounded worker",started:new Date().toISOString(),updated:new Date().toISOString(),state:"running"};
		let control:WorkerControl|undefined, steered:Promise<void>|undefined;
		try {
			store.create(record);
			const request:WorkerRequest={cwd:ctx.cwd,model:record.task.model!,thinking:"low",tools:[],task:record.task.task,systemPrompt:record.systemPrompt,sessionFile:store.sessionFile("w1"),
				onSpawn:pid=>{record.child={...ownIdentity("rpc"),pid,started:processStart(pid)};store.save(record)},onControl:c=>{control=c},
				onEvent:e=>{if(e.type==="agent_start"&&!steered){steered=control!.steer("PI-SMOKE WORKER_STEER");steered.catch(()=>{})}}};
			const first=await runWorker(request); await steered; assert.equal(first.state,"succeeded"); assert.equal(first.turns,2);
			record.state=first.state; record.result=first;delete record.child;store.save(record);store.close();
			store=new WorkerStore(root,parent,ctx.cwd,process.env.AI_PROFILE==="work"?"work":"personal");
			const old=store.resumable("w1");assert.equal(old.task.model,record.task.model);
			let late:Promise<void>|undefined;
			const resumed=await runWorker({...request,task:"PI-SMOKE WORKER_RESUME",onEvent:e=>{
				// Send while the parent is processing settlement, before its transport marks
				// idle. The real child has already settled and must explicitly refuse.
				if(e.type==="agent_settled") {late=control!.steer("MUST_NOT_RUN_LATE_STEER");late.catch(()=>{})}
			}});assert.equal(resumed.state,"succeeded");assert.equal(resumed.turns,1);
			await assert.rejects(late!,/settled/);
			const native=readFileSync(store.sessionFile("w1"),"utf8");assert.match(native,/WORKER_OWN_HISTORY/);assert.match(native,/WORKER_STEER/);assert.match(native,/WORKER_RESUME/);assert.ok(!native.includes("MUST_NOT_RUN_LATE_STEER"));
			const sessions=await SessionManager.list(ctx.cwd);assert.ok(!sessions.some(s=>s.path===store.sessionFile("w1")));
			assert.ok(!native.includes("SENTINEL_PARENT_CONTEXT"));
			console.error("WORKER-DURABLE-PASS");
		} finally {store.close()}
	}});
}
