import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs, { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimCheckout } from "../../home/dot_pi/shared/extensions/subagent/checkout.ts";
import { test } from "node:test";
import { applyImport, createWorkspace, previewImport, validateWorkspace, workspacePath } from "../../home/dot_pi/shared/extensions/subagent/worktree.ts";
import { WorkerPool } from "../../home/dot_pi/shared/extensions/subagent/pool.ts";
import { WorkerStore, type WorkerRecord } from "../../home/dot_pi/shared/extensions/subagent/store.ts";

function git(root: string, ...args: string[]) {
	const p = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
}
function fixture(fn: (root: string, dir: string) => void) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-test-"))), root = join(dir, "repo"); mkdirSync(root);
	try {
		git(root, "init", "-q", "-b", "test");
		writeFileSync(join(root, "a.txt"), "base a\n"); writeFileSync(join(root, "b.txt"), "base b\n"); writeFileSync(join(root, "context.txt"), "context\n");
		writeFileSync(join(root, ".gitignore"), ".env\nignored*\n"); git(root, "add", "."); git(root, "commit", "-qm", "test baseline");
		fn(root, dir);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
const create = (root: string, files = ["a.txt", "b.txt", "added.txt"]) => createWorkspace(root, "parent", "w1", files);

test("worktree snapshots current staged+unstaged+deleted+untracked dirt without touching index/refs", () => fixture(root => {
	writeFileSync(join(root, "a.txt"), "staged\n"); git(root, "add", "a.txt"); writeFileSync(join(root, "a.txt"), "working\n");
	unlinkSync(join(root, "b.txt")); writeFileSync(join(root, "untracked.txt"), "new context\n"); writeFileSync(join(root, ".env"), "DUMMY_SECRET"); writeFileSync(join(root, "ignored-file"), "ignored");
	const index = readFileSync(join(root, ".git", "index")), head = git(root, "rev-parse", "HEAD"), branch = git(root, "symbolic-ref", "HEAD");
	const w = create(root);
	assert.equal(readFileSync(join(w.root, "a.txt"), "utf8"), "working\n"); assert.ok(!existsSync(join(w.root, "b.txt"))); assert.equal(readFileSync(join(w.root, "untracked.txt"), "utf8"), "new context\n");
	assert.ok(!existsSync(join(w.root, ".env"))); assert.ok(!existsSync(join(w.root, "ignored-file")));
	assert.deepEqual(readFileSync(join(root, ".git", "index")), index); assert.equal(git(root, "rev-parse", "HEAD"), head); assert.equal(git(root, "symbolic-ref", "HEAD"), branch);
	assert.equal(previewImport(w).changes.length, 0); assert.equal(validateWorkspace(w, root), w.root);
	assert.throws(() => create(root), /already exists/);
}));
test("owned-only import preserves parent dirt/index, additions/deletions/modes, duplicate import and resumed edits", () => fixture(root => {
	writeFileSync(join(root, "context.txt"), "parent dirt\n"); writeFileSync(join(root, "a.txt"), "staged\n"); git(root, "add", "a.txt"); writeFileSync(join(root, "a.txt"), "working\n");
	const index = readFileSync(join(root, ".git", "index")), w = create(root);
	writeFileSync(join(w.root, "a.txt"), "worker a\n"); chmodSync(join(w.root, "a.txt"), 0o755); unlinkSync(join(w.root, "b.txt")); writeFileSync(join(w.root, "added.txt"), "new file\n");
	const plan = previewImport(w); assert.equal(plan.changes.length, 3); assert.match(plan.diff, /snapshot/); assert.match(plan.diff, /working/); assert.ok(!plan.diff.includes("parent dirt"));
	assert.equal(applyImport(plan), 3); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "worker a\n"); assert.equal(fs.statSync(join(root, "a.txt")).mode & 0o777, 0o755); assert.ok(!existsSync(join(root, "b.txt"))); assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "new file\n");
	assert.equal(readFileSync(join(root, "context.txt"), "utf8"), "parent dirt\n"); assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
	assert.equal(applyImport(previewImport(w)), 0); writeFileSync(join(w.root, "a.txt"), "resumed edit\n"); assert.equal(applyImport(previewImport(w)), 1); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "resumed edit\n");
	assert.ok(existsSync(w.root)); assert.ok(existsSync(join(dirname(w.root), "state.json")));
}));
test("parent conflict, changed preview, and non-owned source changes refuse the whole import", () => fixture(root => {
	const w = create(root); writeFileSync(join(w.root, "a.txt"), "worker\n"); const p = previewImport(w);
	writeFileSync(join(w.root, "a.txt"), "changed after preview\n"); assert.throws(() => applyImport(p), /after the import preview/); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base a\n");
	writeFileSync(join(root, "a.txt"), "parent edit\n"); assert.throws(() => previewImport(w), /Parent changed/); writeFileSync(join(root, "a.txt"), "base a\n");
	writeFileSync(join(w.root, "context.txt"), "non-owned\n"); assert.throws(() => previewImport(w), /non-owned/); assert.equal(readFileSync(join(root, "context.txt"), "utf8"), "context\n");
}));
test("internal plumbing never runs checkout hooks, smudge or fsmonitor", () => fixture((root, dir) => {
	const marker = join(dir, "SIDE_EFFECT"), hook = join(root, ".git", "hooks", "post-checkout");
	writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`); chmodSync(hook, 0o755);
	git(root, "config", "core.fsmonitor", `sh -c \"printf fsmonitor > '${marker}'\"`);
	git(root, "config", "filter.unsafe.smudge", `sh -c \"printf smudge > '${marker}'\"`); git(root, "config", "filter.unsafe.required", "true");
	writeFileSync(join(root, ".gitattributes"), "* filter=unsafe\n"); const w = create(root);
	assert.ok(!existsSync(marker)); assert.equal(readFileSync(join(w.root, "a.txt"), "utf8"), "base a\n");
}));
test("unsafe ownership, symlinks, protected tracked files, sparse layouts and changed HEAD fail closed", () => fixture((root, dir) => {
	for (const p of ["../outside", ".git/config", "a\nb", ".env"]) assert.throws(() => create(root, [p]));
	// Failed validation must not consume w1's retained storage.
	git(root, "config", "core.sparseCheckout", "true"); assert.throws(() => create(root), /Unsupported/); git(root, "config", "core.sparseCheckout", "false");
	writeFileSync(join(dir, "external"), "external"); symlinkSync(join(dir, "external"), join(root, "linked")); assert.throws(() => create(root, ["linked"]), /linked/); unlinkSync(join(root, "linked"));
	const w = create(root); unlinkSync(join(w.root, "a.txt")); symlinkSync(join(dir, "external"), join(w.root, "a.txt")); assert.throws(() => previewImport(w), /linked/); unlinkSync(join(w.root, "a.txt")); writeFileSync(join(w.root, "a.txt"), "base a\n");
	git(root, "commit", "--allow-empty", "-qm", "new head"); assert.throws(() => validateWorkspace(w, root), /HEAD changed/);
	assert.equal(readFileSync(join(dir, "external"), "utf8"), "external");
}));
test("prepared journal blocks re-entry; partial failure rolls back and retains an uncertain journal", () => fixture(root => {
	const w = create(root); writeFileSync(join(w.root, "a.txt"), "new a\n"); writeFileSync(join(w.root, "b.txt"), "new b\n"); const plan = previewImport(w);
	const original = fs.renameSync;
	fs.renameSync = ((from: any, to: any) => { if (String(to) === join(root, "b.txt")) throw new Error("synthetic second-write failure"); return original(from, to); }) as typeof fs.renameSync; syncBuiltinESMExports();
	try { assert.throws(() => applyImport(plan), /rolled back/); } finally { fs.renameSync = original; syncBuiltinESMExports(); }
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base a\n"); assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base b\n");
	assert.match(readFileSync(join(dirname(w.root), "state.json"), "utf8"), /uncertain/); assert.throws(() => previewImport(w), /uncertain/); assert.throws(() => validateWorkspace(w, root), /uncertain/); assert.ok(existsSync(w.root));
}));
test("native worktree headers are bound to the same project; editing records never expire", () => fixture((root, dir) => {
	const w = create(root), storage = join(dir, "workers"); const s = new WorkerStore(storage, "parent", root, "personal");
	const r: WorkerRecord = { version: 1, id: "w1", task: { agent: "worker", task: "bounded", cwd: root, model: "openai/mock", thinking: "low", tools: ["edit"], files: [join(root, "a.txt"), join(root, "b.txt"), join(root, "added.txt")], isolation: "worktree" }, systemPrompt: "fixed", started: new Date().toISOString(), updated: new Date(0).toISOString(), state: "succeeded" };
	try { s.create(r); s.bindWorkspace(r, w); assert.equal(s.load("w1").workspace?.root, w.root); assert.equal(JSON.parse(readFileSync(s.sessionFile("w1"), "utf8")).cwd, w.root); }
	finally { s.close(); }
	assert.equal(WorkerStore.cleanup(storage, "different", Date.now()), 0); assert.ok(existsSync(join(storage, "parent", "w1.jsonl"))); assert.ok(existsSync(w.root));
}));
test("HEAD-only protected copies, ignored non-owned files and invalid UTF-8 cannot be imported", () => {
	fixture(root => { writeFileSync(join(root, ".env"), "DUMMY_PRIVATE_BYTES"); git(root, "add", "-f", ".env"); git(root, "commit", "-qm", "synthetic protected fixture"); git(root, "rm", "--cached", ".env"); assert.throws(() => create(root), /Protected HEAD/); assert.equal(readFileSync(join(root, ".env"), "utf8"), "DUMMY_PRIVATE_BYTES"); });
	fixture(root => { const w = create(root); writeFileSync(join(w.root, "ignored-new-source"), "non-owned ignored data"); assert.throws(() => previewImport(w), /non-owned/); });
	fixture(root => { const w = create(root); writeFileSync(join(w.root, "a.txt"), Buffer.from([0xff, 0xfe])); assert.throws(() => previewImport(w), /invalid UTF-8/); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base a\n"); });
});
test("journal fsync failure precedes every target mutation", () => fixture(root => {
	const w = create(root); writeFileSync(join(w.root, "a.txt"), "worker\n"); const plan = previewImport(w), original = fs.fsyncSync;
	fs.fsyncSync = ((fd: number) => { if (fs.fstatSync(fd).isFile() && readFileSync(fd, "utf8").includes('"state":"prepared"')) throw new Error("synthetic journal fsync failure"); original(fd); }) as typeof fs.fsyncSync; syncBuiltinESMExports();
	try { assert.throws(() => applyImport(plan), /journal fsync/); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base a\n"); assert.ok(existsSync(w.root));
}));
test("checkout lease coordinates separate Pi processes and preserves ambiguous pre-spawn witnesses", () => fixture(root => {
	const module = pathToFileURL(join(process.cwd(), "home/dot_pi/shared/extensions/subagent/checkout.ts")).href;
	const script = `import {claimCheckout} from ${JSON.stringify(module)};try{const l=claimCheckout(${JSON.stringify(root)},true);console.log('OWNED');l.release()}catch(e){console.log('BLOCKED')}`;
	const run = (code = script) => { const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }); assert.equal(p.status, 0, p.stderr); return p.stdout.trim(); };
	const lease = claimCheckout(root, true); try { assert.equal(run(), "BLOCKED"); } finally { lease.release(); }
	assert.equal(run(), "OWNED");
	run(`import {claimCheckout} from ${JSON.stringify(module)};claimCheckout(${JSON.stringify(root)},true,true);process.exit(0)`);
	assert.throws(() => claimCheckout(root), /ambiguous pre-spawn/);
}));
test("snapshot fsync failure leaves creating state, never a ready/importable workspace", () => fixture(root => {
	const original = fs.fsyncSync;
	fs.fsyncSync = ((fd: number) => { if (existsSync(join(root, ".git", "pi-workers", "parent", "w1", "state.json")) && fs.fstatSync(fd).isFile() && readFileSync(fd, "utf8") === "base a\n") throw new Error("synthetic snapshot fsync failure"); original(fd); }) as typeof fs.fsyncSync; syncBuiltinESMExports();
	try { assert.throws(() => create(root), /snapshot fsync/); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
	const m = JSON.parse(readFileSync(join(root, ".git", "pi-workers", "parent", "w1", "state.json"), "utf8")); assert.equal(m.phase, "creating"); assert.throws(() => validateWorkspace(m.workspace, root), /Invalid worktree manifest/);
}));
test("a launch parent dying between preliminary read and acquire cannot be reclaimed", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-checkout-race-"))), module = pathToFileURL(join(process.cwd(), "home/dot_pi/shared/extensions/subagent/checkout.ts")).href;
	const child = spawn(process.execPath, ["--input-type=module", "-e", `import{claimCheckout}from ${JSON.stringify(module)};claimCheckout(${JSON.stringify(dir)},true,true);console.log('READY');setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = once(child, "exit"), original = fs.readFileSync; let killed = false;
	try {
		await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
		fs.readFileSync = ((path: any, ...args: any[]) => { const value = (original as any)(path, ...args); if (typeof path === "string" && path.endsWith(".pi-checkout.lock/owner.json") && !killed) { killed = true; child.kill("SIGKILL"); } return value; }) as typeof fs.readFileSync; syncBuiltinESMExports();
		assert.throws(() => claimCheckout(dir), /inspection before reclaim/); assert.equal(killed, true); await exit; assert.throws(() => claimCheckout(dir), /ambiguous pre-spawn/);
	} finally { fs.readFileSync = original; syncBuiltinESMExports(); child.kill("SIGKILL"); await exit; rmSync(dir, { recursive: true, force: true }); }
});
test("target directory fsync failure after rename rolls back the attempted file", () => fixture(root => {
	const w = create(root); writeFileSync(join(w.root, "a.txt"), "worker\n"); const plan = previewImport(w), original = fs.fsyncSync; let injected = false;
	fs.fsyncSync = ((fd: number) => { if (!injected && fs.fstatSync(fd).isDirectory() && readFileSync(join(root, "a.txt"), "utf8") === "worker\n") { injected = true; throw new Error("synthetic post-rename directory fsync failure"); } original(fd); }) as typeof fs.fsyncSync; syncBuiltinESMExports();
	try { assert.throws(() => applyImport(plan), /rolled back/); } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
	assert.equal(injected, true); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base a\n"); assert.match(readFileSync(join(dirname(w.root), "state.json"), "utf8"), /uncertain/);
}));
test("two isolated writers share capacity but not checkout ownership; import lease is exclusive and invalidated", async () => {
	const pool = new WorkerPool(); pool.activate(); const finish: (() => void)[] = [];
	const request: any = { cwd: process.cwd(), model: "openai/mock", thinking: "low", tools: ["edit"], files: ["owned"], task: "bounded", systemPrompt: "fixed", isolated: true };
	const run = () => new Promise<any>(done => finish.push(() => done({ state: "succeeded", output: "ok" })));
	const a = pool.run(request, run), b = pool.run(request, run); assert.equal(pool.hasWriter, false); assert.throws(() => pool.run(request, run), /At most 2/);
	const lease = pool.reserveCheckout(); assert.equal(pool.hasWriter, true); assert.throws(() => pool.reserveCheckout(), /already owned/);
	await new Promise(done => setTimeout(done, 0)); finish.forEach(fn => fn()); await Promise.all([a, b]); await pool.cancelAll(); assert.equal(lease.valid(), false); pool.activate();
	const fresh = pool.reserveCheckout(); lease.release(); assert.equal(fresh.valid(), true); fresh.release(); assert.equal(pool.hasWriter, false);
});
