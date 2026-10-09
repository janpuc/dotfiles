// Private native Pi transcripts, outside the main session list. The manager lease is taken
// before spawning (Pi may write before extension startup). This is coordination, not a sandbox.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ForkSource } from "./fork.ts";
import { validateWorkspace, type Workspace } from "./worktree.ts";
import { acquire, ownIdentity, ownerAlive, release, type LockOwner } from "../profile/session-lock.ts";
import { validateTools } from "./worker-policy.ts";
import type { WorkerResult } from "./runner.ts";

export interface WorkerTask {
	agent: string; task: string; model?: string; thinking?: string; tools?: string[]; files?: string[]; cwd?: string;
	forkContext?: boolean; isolation?: "worktree";
}
export interface WorkerRecord {
	version: 1; id: string; task: WorkerTask; systemPrompt: string; started: string; updated: string;
	state: "running" | "interrupted" | WorkerResult["state"]; result?: WorkerResult; child?: LockOwner;
	fork?: ForkSource; workspace?: Workspace;
}
const leases: Set<string> = ((globalThis as any)[Symbol.for("pi-workers.storage-leases")] ??= new Set());
const name = (s: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(s) && !s.includes("..");
const workerId = (s: string) => /^w[1-9]\d{0,8}$/.test(s);
const string = (v: unknown, max = 65536): v is string => typeof v === "string" && Buffer.byteLength(v) <= max;
function regular(file: string) {
	if (!lstatSync(file).isFile()) throw new Error(`Worker storage is not a regular file: ${file}`);
}
function directory(dir: string) {
	if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
	if (!lstatSync(dir).isDirectory()) throw new Error(`Worker storage is not a real directory: ${dir}`);
}
function read(file: string, max = 256 * 1024) {
	regular(file);
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const b = Buffer.alloc(max + 1), n = readSync(fd, b, 0, b.length, 0);
		if (n > max) throw new Error(`Worker record exceeds its storage bound: ${file}`);
		return b.subarray(0, n).toString("utf8");
	} finally { closeSync(fd); }
}
function atomic(file: string, value: unknown) {
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error("Worker metadata exceeds its storage bound");
	if (existsSync(file)) regular(file);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, encoded, { mode: 0o600, flag: "wx" });
	try { renameSync(tmp, file); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
function valid(record: any, id: string): record is WorkerRecord {
	const t = record?.task;
	return record?.version === 1 && record.id === id && workerId(id) &&
		["scout", "planner", "worker", "reviewer"].includes(t?.agent) && string(t.task) && string(t.cwd, 4096) &&
		string(t.model, 256) && /^[\w-]+\/[^\s:]+$/.test(t.model) &&
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(t.thinking) &&
		(t.forkContext === undefined || typeof t.forkContext === "boolean") && (t.isolation === undefined || t.isolation === "worktree") &&
		(!record.fork || (record.fork.version === 1 && string(record.fork.parent, 96) && (record.fork.leaf === null || string(record.fork.leaf, 96)) && /^[a-f0-9]{64}$/.test(record.fork.hash) && Number.isInteger(record.fork.messages) && Number.isInteger(record.fork.omitted))) &&
		(!record.workspace || t.isolation === "worktree") &&
		Array.isArray(t.tools) && t.tools.every((v: unknown) => typeof v === "string") &&
		(t.files === undefined || (Array.isArray(t.files) && t.files.length <= 100 && t.files.every((v: unknown) => string(v, 4096)))) &&
		string(record.systemPrompt) && Number.isFinite(Date.parse(record.started)) && Number.isFinite(Date.parse(record.updated)) &&
		["running", "interrupted", "succeeded", "failed", "cancelled", "timed_out"].includes(record.state) &&
		(!record.result || (string(record.result.output, 49152) && (!record.result.error || string(record.result.error, 49152)))) &&
		(!record.child || (Number.isInteger(record.child.pid) && record.child.pid > 0 &&
			["host", "boot", "started", "at"].every(k => string(record.child[k], 256))));
}

export class WorkerStore {
	readonly dir: string;
	private readonly me = ownIdentity("tui");
	private closed = false;
	private readonly scope: { version: number; parent: string; cwd: string; profile: string };
	constructor(root: string, parent: string, cwd: string, profile: string) {
		if (!name(parent) || !["personal", "work"].includes(profile)) throw new Error("Invalid worker storage scope");
		// Canonicalize the existing agent directory, but reject symlinks within workers/.
		const base = join(realpathSync(dirname(resolve(root))), basename(root));
		directory(base);
		this.dir = join(base, parent); directory(this.dir);
		this.scope = { version: 1, parent, cwd: realpathSync(cwd), profile };
		const lock = join(this.dir, "manager");
		if (existsSync(`${lock}.lock`)) {
			directory(`${lock}.lock`);
			if (existsSync(join(`${lock}.lock`, "owner.json"))) regular(join(`${lock}.lock`, "owner.json"));
		}
		if (leases.has(this.dir)) throw new Error("Worker transcripts already have a manager in this process");
		const got = acquire(lock, this.me);
		if (!got.ok) throw new Error(`Worker transcripts are locked: ${got.reason}`);
		leases.add(this.dir);
		try {
			const scopeFile = join(this.dir, "scope.json");
			if (existsSync(scopeFile)) {
				if (JSON.stringify(JSON.parse(read(scopeFile))) !== JSON.stringify(this.scope)) throw new Error("Worker transcript project or memory scope mismatch");
			} else {
				if (readdirSync(this.dir).some(n => n !== "manager.lock")) throw new Error("Unknown contents in worker transcript directory");
				atomic(scopeFile, this.scope);
			}
		} catch (e) { this.close(); throw e; }
	}
	close() { if (!this.closed) { this.closed = true; release(join(this.dir, "manager"), this.me); leases.delete(this.dir); } }
	private active() { if (this.closed) throw new Error("Worker transcript store is closed"); }
	sessionFile(id: string) { this.active(); if (!workerId(id)) throw new Error("Invalid worker id"); return join(this.dir, `${id}.jsonl`); }
	private recordFile(id: string) { this.sessionFile(id); return join(this.dir, `${id}.json`); }
	ids() { this.active(); return [...new Set(readdirSync(this.dir).map(n => /^(w[1-9]\d{0,8})\.(?:json|jsonl)$/.exec(n)?.[1]).filter((n): n is string => !!n))].sort((a,b) => Number(a.slice(1)) - Number(b.slice(1))); }
	load(id: string): WorkerRecord {
		const r = JSON.parse(read(this.recordFile(id)));
		if (!valid(r, id) || realpathSync(r.task.cwd!) !== this.scope.cwd) throw new Error(`Invalid worker metadata: ${id}`);
		validateTools(r.task.tools!);
		const cwd = r.workspace ? validateWorkspace(r.workspace, this.scope.cwd, this.scope.parent, id) : this.scope.cwd;
		const workspace = r.workspace;
		if (workspace && JSON.stringify(workspace.files) !== JSON.stringify([...new Set((r.task.files ?? []).map((p: string) => relative(workspace.parentRoot, p)))].sort())) throw new Error("Worker worktree ownership mismatch");
		const file = this.sessionFile(id); regular(file);
		const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const b = Buffer.alloc(8192), n = readSync(fd, b, 0, b.length, 0);
			const h = JSON.parse(b.subarray(0,n).toString("utf8").split("\n")[0]);
			if (h.type !== "session" || h.version !== 3 || h.id !== id || realpathSync(h.cwd) !== cwd) throw new Error(`Invalid native worker session: ${id}`);
		} finally { closeSync(fd); }
		return r;
	}
	resumable(id: string) {
		const r = this.load(id);
		if (r.task.isolation && !r.workspace) throw new Error("Worktree initialization did not complete; retain/inspect its private storage and start a new worker");
		if (r.child && ownerAlive(r.child)) throw new Error(`Worker ${id} still has a live or unconfirmed child; wait before resuming`);
		if (r.state === "running" && !r.child) throw new Error(`Worker ${id} lost its process witness; inspect before resuming`);
		return r;
	}
	create(record: WorkerRecord, seed?: string) {
		this.active();
		if (!valid(record, record.id)) throw new Error("Invalid new worker metadata");
		if (seed !== undefined && (!record.fork || Buffer.byteLength(seed) > 49152 || createHash("sha256").update(seed).digest("hex") !== record.fork.hash)) throw new Error("Invalid fork seed");
		const header = JSON.stringify({ type: "session", version: 3, id: record.id, timestamp: record.started, cwd: this.scope.cwd }) + "\n";
		const entry = seed === undefined ? "" : JSON.stringify({ type: "message", id: randomBytes(4).toString("hex"), parentId: null,
			timestamp: record.started, message: { role: "user", content: seed, timestamp: Date.parse(record.started) } }) + "\n";
		writeFileSync(this.sessionFile(record.id), header + entry, { mode: 0o600, flag: "wx" });
		this.save(record);
	}
	bindWorkspace(record: WorkerRecord, workspace: Workspace) {
		this.active(); const cwd = validateWorkspace(workspace, this.scope.cwd, this.scope.parent, record.id);
		const file = this.sessionFile(record.id), lines = read(file).split("\n"), h = JSON.parse(lines[0]);
		if (record.child || lines.length > 3 || h.cwd !== this.scope.cwd) throw new Error("Worker transcript cannot be rebound after launch");
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, [JSON.stringify({ ...h, cwd }), ...lines.slice(1)].join("\n"), { mode: 0o600, flag: "wx" });
		try { renameSync(tmp, file); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
		record.workspace = workspace; this.save(record);
	}
	save(record: WorkerRecord) { this.active(); if (!valid(record, record.id)) throw new Error("Invalid worker metadata"); atomic(this.recordFile(record.id), record); }
	messages(id: string): { role: string; content: unknown; toolName?: string; isError?: boolean; errorMessage?: string }[] {
		const file = this.sessionFile(id); regular(file);
		const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const size = lstatSync(file).size, start = Math.max(0, size - 512 * 1024), b = Buffer.alloc(Math.min(size, 512 * 1024));
			readSync(fd, b, 0, b.length, start);
			const lines = b.toString("utf8").split("\n"); if (start) lines.shift();
			return lines.flatMap(line => { try { const e = JSON.parse(line); return e.type === "custom_message" && e.customType === "pi-worker-steering" ? [{ role: "user", content: e.content }] : e.type === "message" && ["user", "assistant", "toolResult"].includes(e.message?.role) ? [e.message] : []; } catch { return []; } }).slice(-96);
		} finally { closeSync(fd); }
	}
	/** Locked, conservative retention: only verified pairs; never unknown contents or live children. */
	static cleanup(root: string, current: string, now = Date.now()): number {
		if (!existsSync(root) || !lstatSync(root).isDirectory()) return 0;
		let count = 0;
		for (const parent of readdirSync(root)) {
			if (parent === current || !name(parent)) continue;
			let store: WorkerStore | undefined;
			try {
				const dir = join(root, parent); if (!lstatSync(dir).isDirectory()) continue;
				const scope = JSON.parse(read(join(dir, "scope.json")));
				if (scope.version !== 1 || scope.parent !== parent) continue;
				store = new WorkerStore(root, parent, scope.cwd, scope.profile);
				for (const id of store.ids()) {
					try {
						const r = store.resumable(id);
						// Editing work and import journals are never retention garbage.
						if (r.task.isolation || r.task.tools?.some(t => ["edit", "write", "bash"].includes(t)) || now - Date.parse(r.updated) <= 30 * 86400_000) continue;
						unlinkSync(store.sessionFile(id)); unlinkSync(store.recordFile(id)); count++;
					} catch { /* ambiguous, corrupt or live: preserve */ }
				}
			} catch { /* unknown scope or lease: preserve */ } finally { store?.close(); }
		}
		return count;
	}
}
