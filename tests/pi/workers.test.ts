import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boundedText, briefTask, defaultWorkerModel, validateTools, workerEnvironment } from "../../home/dot_pi/shared/extensions/subagent/worker-policy.ts";
import { collectWorker, validateClaudeProject, type WorkerRequest } from "../../home/dot_pi/shared/extensions/subagent/runner.ts";
import { WorkerPool } from "../../home/dot_pi/shared/extensions/subagent/pool.ts";

test("task briefs collapse whitespace and truncate without splitting emoji", () => {
	assert.equal(briefTask("Short task"), "Short task");
	assert.equal(briefTask(" \tFirst\n\nsecond\r\n third  "), "First second third");
	const truncated = briefTask("abcdefgh", 5);
	assert.equal(truncated, "abcd…"); assert.equal(truncated.length, 5);
	assert.equal(briefTask("x".repeat(121)), "x".repeat(119) + "…");
	const emoji = briefTask("abc😀def", 5);
	assert.equal(emoji, "abc😀…"); assert.equal(Array.from(emoji).length, 5);
});

test("worker tools are exact and memory-free", () => {
	assert.deepEqual(validateTools([]), []);
	assert.deepEqual(validateTools(["read", "read", "fetch_content"]), ["read", "fetch_content"]);
	for (const tool of ["*", "+bash", "memory_recall", "subagent", "web_enable", "codemode"]) assert.throws(() => validateTools([tool]));
});

test("worker environment removes memory, Git selectors and parent metadata but keeps the memory scope marker", () => {
	const env = workerEnvironment({ AI_PROFILE: "work", CLAUDE_CONFIG_DIR: "/personal/claude",
		GIT_DIR: "/parent/.git", GIT_WORK_TREE: "/parent", GIT_INDEX_FILE: "/parent-index", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/unrelated-hooks", MEMINI_API_KEY: "dummy", PI_MEMINI_API_KEY: "dummy", MEMINI_HOME: "personal/dummy", PI_DETACH_ID: "parent", PI_DETACH_DIR: "/attach", PI_CODING_AGENT_SESSION_DIR: "/parent", PI_SESSION_ID: "parent", PI_SESSION_FILE: "/parent.jsonl", PI_MODEL: "parent-model", CLAUDECODE: "1" }, [], "brief");
	assert.equal(env.AI_PROFILE, "work"); assert.equal(env.CLAUDE_CONFIG_DIR, "/personal/claude");
	assert.equal(env.PI_WORKER, "1"); assert.equal(env.PI_MEMINI_STATE, "off: task worker");
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "MEMINI_API_KEY", "PI_MEMINI_API_KEY", "MEMINI_HOME", "PI_DETACH_ID", "PI_DETACH_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "CLAUDECODE"]) assert.equal(env[key], undefined);
	assert.equal(env.PI_WORKER_SYSTEM_PROMPT, undefined); assert.equal(env.PI_WORKER_PROMPT_FILE, "brief");
	assert.equal(env.PI_WORKER_PARENT_PID, String(process.pid));
	assert.equal(defaultWorkerModel("reviewer").model, "openai/gpt-6.1-sol");
	assert.equal(defaultWorkerModel("scout").model, "minimax/MiniMax-M3");
});

// Fake RPC child deliberately fragments UTF-8 output and never makes network calls.
const child = String.raw`
const fs = require('node:fs'); const readline = require('node:readline');
const emit = (event) => { const b = Buffer.from(JSON.stringify(event)+'\n'); for(let i=0;i<b.length;i+=7) process.stdout.write(b.subarray(i,i+7)); };
if (['stubborn','shutdownhang'].includes(process.env.MODE)) process.on('SIGTERM', () => {});
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
 const q=JSON.parse(line); fs.appendFileSync(process.env.TRACE, q.type+':'+(q.message||'')+'\n');
 if(q.type==='get_commands') return emit({type:'response',command:'get_commands',success:true,data:{commands:process.env.MODE==='missing'?[]:[{name:'worker-ready'}]}});
 if(q.message==='/worker-ready') return emit({type:'message_end',message:{role:'custom',customType:'pi-worker-ready',details:{model:'openai/mock',tools:[]}}});
 if(q.message?.startsWith('/worker-steer ')) { emit({type:'message_end',message:{role:'custom',customType:'pi-worker-steer-ack',details:{id:q.id,accepted:process.env.MODE!=='steer-late',error:process.env.MODE==='steer-late'?'already settled; resume explicitly':undefined}}}); return emit({id:q.id,type:'response',command:'prompt',success:true,data:{disposition:'handled'}}); }
 if(process.env.MODE?.startsWith('steer')) {
   emit({type:'agent_start'});
   const done=()=>{emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'steered evidence'}],stopReason:'stop'}});emit({type:'agent_settled'});};
   if(process.env.MODE==='steer-hang') setInterval(()=>{},1000);
   else if(process.env.MODE==='steer-late') done(); else setTimeout(done,100);
   return;
 }
 if(process.env.MODE==='pipe') { const p=require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});fs.writeFileSync(process.env.TRACE+'.pid',String(p.pid));setInterval(()=>{},1000);return; }
 if(process.env.MODE==='stubborn' || process.env.MODE==='hang') {setInterval(()=>{},1000);return;}
 if(process.env.MODE==='recovered') emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'retryable 503'}});
 emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Evidence 🧪 Zażółć\u2028safe'}],stopReason:'stop'}});
 if(process.env.MODE==='failure') emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'quota refused'}});
 emit({type:'agent_settled'});
});
rl.on('close',()=>{ if(process.env.MODE==='disposalkill') process.kill(process.pid,'SIGKILL'); if(process.env.MODE==='shutdownhang') setInterval(()=>{},1000); else process.exit(process.env.MODE==='badexit'?7:0); });
`;
async function transport(mode: string, timeoutMs = 5000, signal?: AbortSignal, extra: Partial<WorkerRequest> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-worker-test-"));
	try {
		const file = join(dir, "child.cjs"), trace = join(dir, "trace"); await writeFile(file, child);
		const request: WorkerRequest = { cwd: dir, model: "openai/mock", thinking: "low", tools: [], task: "bounded task", systemPrompt: "minimal", timeoutMs, signal, ...extra };
		const result = await collectWorker(process.execPath, [file], { ...process.env, MODE: mode, TRACE: trace }, request);
		return { result, trace: await readFile(trace, "utf8").catch(() => ""), pipeSpawned: Boolean(await readFile(trace + ".pid", "utf8").catch(() => "")) };
	} finally {
		const pid = Number(await readFile(join(dir, "trace.pid"), "utf8").catch(() => ""));
		if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch {} }
		await rm(dir, { recursive: true, force: true });
	}
}

test("RPC readiness precedes task and final Unicode output survives fragmented bytes", async () => {
	const { result, trace } = await transport("ok");
	assert.equal(result.state, "succeeded"); assert.match(result.output, /🧪 Zażółć/);
	assert.equal(trace, "get_commands:\nprompt:/worker-ready\nprompt:bounded task\n");
});
test("UTF-8 result budgets do not split code points", () => {
	const text = boundedText("😀".repeat(20000));
	assert.ok(Buffer.byteLength(text) <= 49152); assert.ok(!text.includes("�"));
});
test("live steering is acknowledged; rejected settle-race steering cannot revive a run", async () => {
	for (const mode of ["steer", "steer-late"]) {
		let control: any, acknowledgement: Promise<void> | undefined;
		const { result, trace } = await transport(mode, 5000, undefined, {
			onControl: c => { control = c; },
			onEvent: e => { if(e.type === "agent_start") { acknowledgement = control.steer("changed focus"); acknowledgement!.catch(() => {}); } },
		});
		assert.equal(result.state, "succeeded"); assert.equal(result.turns, 1);
		assert.equal(trace.split("prompt:/worker-steer ").length, 2);
		if(mode === "steer-late") await assert.rejects(acknowledgement!, /settled/); else await acknowledgement;
		await assert.rejects(control.steer("too late"), /settling|ready/);
	}
});
test("steering does not reset the hard time budget", async () => {
	let control: any;
	const { result } = await transport("steer-hang", 150, undefined, { onControl: c => { control=c; },
		onEvent: e => { if(e.type === "agent_start") void control.steer("change").catch(() => {}); } });
	assert.equal(result.state, "timed_out");
});
test("missing mandatory bootstrap sends no assignment", async () => {
	const { result, trace } = await transport("missing");
	assert.equal(result.state, "failed"); assert.match(result.error!, /bootstrap/); assert.equal(trace, "get_commands:\n");
});
test("partial answer is not success after provider failure or nonzero exit", async () => {
	assert.equal((await transport("failure")).result.state, "failed");
	assert.equal((await transport("badexit")).result.state, "failed");
});
test("a recovered provider retry does not poison final success", async () => {
	assert.equal((await transport("recovered")).result.state, "succeeded");
});
test("timeout escalates SIGTERM-resistant process; cancellation is terminal", async () => {
	assert.equal((await transport("stubborn", 100)).result.state, "timed_out");
	const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
	assert.equal((await transport("hang", 5000, controller.signal)).result.state, "cancelled");
});
test("settled output survives a hanging shutdown and post-settle abort", async () => {
	assert.equal((await transport("disposalkill")).result.state, "succeeded");
	assert.equal((await transport("shutdownhang", 500)).result.state, "succeeded");
	const controller = new AbortController(); setTimeout(() => controller.abort(), 150);
	assert.equal((await transport("shutdownhang", 5000, controller.signal)).result.state, "succeeded");
});
test("an escaped pipe holder cannot make cancellation wait forever", async () => {
	const start = Date.now(); const { result, pipeSpawned } = await transport("pipe", 300);
	assert.equal(pipeSpawned, true); assert.equal(result.state, "timed_out");
	assert.ok(Date.now() - start < 4000);
});

test("one pool per process even across separately loaded module instances", async () => {
	const url = new URL("../../home/dot_pi/shared/extensions/subagent/pool.ts", import.meta.url).href;
	const a = await import(`${url}?instance=a`), b = await import(`${url}?instance=b`);
	assert.notEqual(a.WorkerPool, b.WorkerPool); // distinct module instances, as Pi's loader creates
	assert.equal(a.workerPool, b.workerPool);
});

test("one pool reserves every child synchronously and cancels queued work before launch", async () => {
	const pool = new WorkerPool(); pool.activate(); let launched = 0;
	const request: WorkerRequest = { cwd: process.cwd(), model: "openai/mock", thinking: "low", tools: [], task: "bounded", systemPrompt: "minimal" };
	const run = async (r: WorkerRequest): Promise<any> => { launched++; throw new Error("should not dispatch cancelled work"); };
	const first = pool.run(request, run), second = pool.run(request, run);
	assert.throws(() => pool.run(request, run), /At most 2/);
	await pool.cancelAll(); assert.equal(pool.count, 0); assert.equal(launched, 0);
	assert.equal((await first).state, "cancelled"); assert.equal((await second).state, "cancelled");
});

test("parent loss kills a TERM-resistant descendant even when the worker would exit on TERM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-orphan-test-"));
	let worker = 0, descendant = 0;
	try {
		const workerFile = join(dir, "worker.cjs"), parentFile = join(dir, "parent.cjs"), pidFile = join(dir, "worker.pid"), descFile = join(dir, "desc.pid");
		const policy = pathToFileURL(join(process.cwd(), "home/dot_pi/shared/extensions/subagent/worker-policy.ts")).href;
		await writeFile(workerFile, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>process.exit(0));import(${JSON.stringify(policy)}).then(({startParentWatch})=>{require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(descFile)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore'});startParentWatch(Number(process.env.TEST_PARENT),40);setInterval(()=>{},1000);});`);
		await writeFile(parentFile, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(workerFile)}],{detached:true,stdio:'ignore',env:{...process.env,TEST_PARENT:String(process.pid)}});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(descFile)}))process.exit(0)},20);`);
		const parent = spawn(process.execPath, [parentFile], { stdio: "ignore" });
		await new Promise<void>((done, reject) => {
			const timer = setTimeout(() => { parent.kill("SIGKILL"); reject(new Error("orphan fixture did not initialize")); }, 4000);
			parent.once("close", () => { clearTimeout(timer); done(); }); parent.once("error", reject);
		});
		worker = Number(await readFile(pidFile, "utf8")); descendant = Number(await readFile(descFile, "utf8"));
		const alive = (pid: number) => { try { process.kill(pid, 0); return !spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim().startsWith("Z"); } catch { return false; } };
		for (let i = 0; i < 60 && (alive(worker) || alive(descendant)); i++) await new Promise((done) => setTimeout(done, 50));
		assert.equal(alive(worker), false); assert.equal(alive(descendant), false);
	} finally {
		worker ||= Number(await readFile(join(dir, "worker.pid"), "utf8").catch(() => ""));
		if (worker > 0) { try { process.kill(-worker, "SIGKILL"); } catch {} }
		if (descendant > 0) { try { process.kill(descendant, "SIGKILL"); } catch {} }
		await rm(dir, { recursive: true, force: true });
	}
});

test("Claude project billing overrides are rejected before dispatch", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-claude-settings-test-"));
	try {
		const { mkdir } = await import("node:fs/promises"); await mkdir(join(dir, ".claude"));
		await writeFile(join(dir, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "bad" }));
		assert.throws(() => validateClaudeProject(dir), /billing override/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
