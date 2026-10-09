import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerStore, type WorkerRecord } from "../../home/dot_pi/shared/extensions/subagent/store.ts";
import { ownIdentity } from "../../home/dot_pi/shared/extensions/profile/session-lock.ts";

function fixture(fn: (root: string, cwd: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pi-store-test-")), root = join(dir, "workers");
	try { fn(root, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const record = (cwd: string): WorkerRecord => ({ version: 1, id: "w1", task: { agent: "worker", task: "bounded work", cwd,
	model: "openai/mock", thinking: "low", tools: ["read"] }, systemPrompt: "fixed role prompt", started: new Date().toISOString(), updated: new Date().toISOString(), state: "running" });

test("private native JSONL outside sessions; immutable scope and ids survive reopening", () => fixture((root,cwd) => {
	let s = new WorkerStore(root, "parent-1", cwd, "personal");
	const r = record(cwd); s.create(r); assert.deepEqual(s.ids(), ["w1"]);
	assert.equal(JSON.parse(readFileSync(s.sessionFile("w1"), "utf8")).id, "w1");
	assert.equal(statSync(s.sessionFile("w1")).mode & 0o777, 0o600);
	assert.equal(statSync(s.dir).mode & 0o777, 0o700);
	assert.throws(() => s.create(r), /EEXIST/); s.close();
	s = new WorkerStore(root, "parent-1", cwd, "personal"); assert.equal(s.load("w1").systemPrompt, "fixed role prompt"); s.close();
	assert.throws(() => new WorkerStore(root, "parent-1", cwd, "work"), /scope mismatch/);
}));
test("one manager per parent, including duplicate module instances in the same process", () => fixture((root,cwd) => {
	const s = new WorkerStore(root, "parent", cwd, "personal");
	try { assert.throws(() => new WorkerStore(root, "parent", cwd, "personal"), /already have a manager/); }
	finally { s.close(); }
	const next = new WorkerStore(root, "parent", cwd, "personal"); next.close();
}));
test("live child or missing process witness prevents concurrent durable resume", () => fixture((root,cwd) => {
	const s = new WorkerStore(root, "parent", cwd, "personal");
	try {
		const r = record(cwd); s.create(r); assert.throws(() => s.resumable("w1"), /process witness/);
		r.child = ownIdentity("rpc"); s.save(r); assert.throws(() => s.resumable("w1"), /live or unconfirmed/);
		r.child.started = ""; s.save(r); assert.throws(() => s.resumable("w1"), /live or unconfirmed/);
		r.child = { ...r.child, pid: 99999999 }; s.save(r); assert.equal(s.resumable("w1").id, "w1");
	} finally { s.close(); }
}));
test("corruption, missing session, invalid names and symlinks fail closed before reads/writes", () => fixture((root,cwd) => {
	assert.throws(() => new WorkerStore(root, "../parent", cwd, "personal"), /scope/);
	const s = new WorkerStore(root, "parent", cwd, "personal");
	try {
		const r = record(cwd); s.create(r);
		assert.throws(() => s.sessionFile("../w1"), /id/);
		const file = s.sessionFile("w1"), other = join(cwd, "other"); writeFileSync(other, "keep");
		unlinkSync(file); symlinkSync(other, file); assert.throws(() => s.load("w1"), /regular/);
		assert.throws(() => s.messages("w1"), /regular/); assert.equal(readFileSync(other,"utf8"), "keep");
		unlinkSync(file); assert.throws(() => s.load("w1"), /ENOENT/);
		writeFileSync(join(s.dir,"w1.json"), JSON.stringify({ ...r, task: { ...r.task, tools: ["memory_recall"] } }));
		assert.throws(() => s.load("w1"), /exact supported/);
	} finally { s.close(); }
	const evil = join(cwd,"evil"); mkdirSync(evil); symlinkSync(evil,join(root,"linked"));
	assert.throws(() => new WorkerStore(root,"linked",cwd,"personal"), /real directory/);
}));
test("native transcript is the only history, read as a bounded recent tail", () => fixture((root,cwd) => {
	const s = new WorkerStore(root,"parent",cwd,"personal");
	try {
		s.create(record(cwd));
		const file = s.sessionFile("w1"), header = readFileSync(file,"utf8");
		writeFileSync(file,header + Array.from({length:110},(_,i) => JSON.stringify({type:"message",message:{role:"user",content:String(i)}})).join("\n")+"\n");
		const messages = s.messages("w1"); assert.equal(messages.length,96); assert.equal(messages[0].content,"14");
		assert.equal(s.load("w1").task.task,"bounded work");
	} finally { s.close(); }
}));
test("30-day retention is locked and preserves current/live/corrupt/unknown files", () => fixture((root,cwd) => {
	let s = new WorkerStore(root,"old",cwd,"personal");
	const r = record(cwd); r.state = "succeeded"; r.updated = new Date(0).toISOString(); s.create(r);
	const native = s.sessionFile("w1"); writeFileSync(join(s.dir,"unknown.txt"),"keep");
	assert.equal(WorkerStore.cleanup(root,"current"),0); s.close();
	assert.equal(WorkerStore.cleanup(root,"old"),0);
	assert.equal(WorkerStore.cleanup(root,"current"),1);
	assert.throws(() => statSync(native),/ENOENT/); assert.equal(readFileSync(join(root,"old","unknown.txt"),"utf8"),"keep");
	s = new WorkerStore(root,"live",cwd,"personal"); r.child = ownIdentity("rpc"); s.create(r); s.close();
	assert.equal(WorkerStore.cleanup(root,"current"),0);
}));
