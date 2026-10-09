// Conservative dirty snapshots and manual, hash-guarded imports. No branch/stash/commit changes.
// Private detached checkouts and journals are retained; this is coordination, not an OS sandbox.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyTool } from "../profile/effects.ts";
import { claimCheckout } from "./checkout.ts";
import { isUtf8 } from "node:buffer";

export interface Workspace { version: 1; parent: string; id: string; parentCwd: string; parentRoot: string; commonDir: string; head: string; root: string; files: string[] }
type State = { hash: string; mode: number } | null;
interface Manifest { version: 1; workspace: Workspace; baseline: Record<string, State>; phase: "creating" | "ready";
	import?: { at: string; changes: Change[]; state: "prepared" | "uncertain"; createdDirs?: string[] } }
export interface Change { path: string; before: State; after: State }
export interface ImportPlan { workspace: Workspace; changes: Change[]; hash: string; diff: string }
const MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_STATE = 2 * 1024 * 1024;
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root: string, p: string) => { const r = relative(root, p); return !isAbsolute(r) && r !== ".." && !r.startsWith("../"); };
function git(cwd: string, args: string[], optional = false): string {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });
	const p = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-C", cwd, ...args],
		{ env, encoding: "utf8", timeout: 10000, maxBuffer: MAX_STATE });
	if (p.error || (p.status !== 0 && !(optional && p.status === 1))) throw new Error(`Worktree Git operation failed (${args[0]}): ${p.error ?? p.stderr.trim()}`);
	return p.stdout;
}
function sync(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function dir(path: string) {
	if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); sync(dirname(path)); }
	if (!lstatSync(path).isDirectory()) throw new Error("Worktree storage must use real directories");
}
/** Refuse special files, links, Git metadata and ambiguous/control-character path spellings. */
export function workspacePath(root: string, name: string): string {
	if (!name || isAbsolute(name) || /[\\\x00-\x1f\x7f-\x9f]/.test(name) || name.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))
		throw new Error("Unsafe worktree path");
	const path = resolve(root, name); if (!inside(root, path)) throw new Error("Worktree path escapes its checkout");
	let current = root;
	if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Worktree root changed or is linked");
	for (const part of name.split("/")) {
		current = join(current, part);
		try { const s = lstatSync(current); if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw new Error("Worktrees do not support linked/special paths"); }
		catch (e: any) { if (e.code !== "ENOENT") throw e; }
	}
	return path;
}
function bytes(file: string, max = MAX_FILE): { data: Buffer; state: NonNullable<State> } {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o7000) || s.size > max) throw new Error("Unsupported or oversized worktree file");
		const b = Buffer.alloc(s.size + 1), n = readSync(fd, b, 0, b.length, 0);
		if (n !== s.size) throw new Error("Worktree file changed while reading");
		const data = b.subarray(0, n); return { data, state: { hash: hash(data), mode: s.mode & 0o777 } };
	} finally { closeSync(fd); }
}
function state(root: string, name: string): State {
	const p = workspacePath(root, name);
	try { return bytes(p).state; } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}
function secret(root: string, name: string) {
	return classifyTool("read", { path: join(root, name) }, { cwd: root, projectRoot: root, home: process.env.HOME! }).some(e => e.class === "secret");
}
function identity(cwd: string) {
	const parentCwd = realpathSync(cwd), parentRoot = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
	const commonDir = realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
	if (!inside(parentRoot, parentCwd) || commonDir !== join(parentRoot, ".git") || !lstatSync(commonDir).isDirectory())
		throw new Error("Worktree snapshots initially require an ordinary, non-linked parent repository");
	if (git(cwd, ["config", "--get", "core.worktree"], true).trim() || git(cwd, ["config", "--bool", "--get", "extensions.worktreeConfig"], true).trim() === "true" ||
		git(cwd, ["config", "--bool", "--get", "core.sparseCheckout"], true).trim() === "true" || git(cwd, ["ls-files", "--unmerged"]).trim())
		throw new Error("Unsupported worktree/sparse/unresolved repository configuration");
	if (/(?:^|\x00)160000 /.test(git(cwd, ["ls-files", "--stage", "-z"])) || /(?:^|\x00)160000 /.test(git(cwd, ["ls-tree", "-r", "-z", "HEAD"])))
		throw new Error("Worktree snapshots do not support submodules");
	const head = git(cwd, ["rev-parse", "HEAD"]).trim(); if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Worktrees require a local committed HEAD");
	return { parentCwd, parentRoot, commonDir, head };
}
function names(root: string, extra: string[]): string[] {
	const tracked = git(root, ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean);
	for (const p of tracked) if (secret(root, p)) throw new Error("Protected tracked files prevent a worktree snapshot/import");
	const other = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(p => p && !secret(root, p));
	const all = [...new Set([...tracked, ...other, ...extra])].sort();
	if (all.length > 10000 || new Set(all.map(p => p.toLowerCase())).size !== all.length) throw new Error("Worktree snapshot exceeds its bound or has case-ambiguous paths");
	return all;
}
const home = (w: Workspace) => dirname(w.root);
const manifestPath = (w: Workspace) => join(home(w), "state.json");
function save(m: Manifest) {
	const data = JSON.stringify(m); if (Buffer.byteLength(data) > MAX_STATE) throw new Error("Worktree manifest exceeds its bound");
	const path = manifestPath(m.workspace); if (existsSync(path)) bytes(path, MAX_STATE);
	const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
	try { sync(tmp); renameSync(tmp, path); sync(dirname(path)); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
function blob(w: Workspace, s: NonNullable<State>, data?: Buffer): Buffer {
	if (!/^[a-f0-9]{64}$/.test(s.hash)) throw new Error("Invalid worktree blob hash");
	const p = join(home(w), "blobs", s.hash);
	if (data && hash(data) !== s.hash) throw new Error("Worktree changed while preparing an import blob");
	if (data && !existsSync(p)) { writeFileSync(p, data, { mode: 0o600, flag: "wx" }); sync(p); sync(dirname(p)); }
	const b = bytes(p).data; if (hash(b) !== s.hash) throw new Error("Worktree baseline blob is corrupt"); return b;
}
function load(w: Workspace): Manifest {
	const m = JSON.parse(bytes(manifestPath(w), MAX_STATE).data.toString("utf8"));
	if (m.version !== 1 || m.phase !== "ready" || !same(m.workspace, w) || !m.baseline || typeof m.baseline !== "object" || Array.isArray(m.baseline)) throw new Error("Invalid worktree manifest");
	for (const [p, s] of Object.entries(m.baseline) as [string, State][]) {
		workspacePath(w.root, p);
		if (s && (!/^[a-f0-9]{64}$/.test(s.hash) || !Number.isInteger(s.mode) || s.mode < 0 || s.mode > 0o777)) throw new Error("Invalid worktree baseline");
	}
	if (m.import) throw new Error("Worktree has a prepared/uncertain import; inspect its retained journal before any resume/import");
	return m;
}
export function validateWorkspace(w: Workspace, parentCwd: string, parent?: string, id?: string): string {
	if (w?.version !== 1 || !/^[\w-]{1,96}$/.test(w.parent) || !/^w[1-9]\d{0,8}$/.test(w.id) || (parent && parent !== w.parent) || (id && id !== w.id)) throw new Error("Invalid worktree identity");
	const actual = identity(parentCwd);
	for (const k of ["parentCwd", "parentRoot", "commonDir", "head"] as const) if (actual[k] !== w[k]) throw new Error("Worktree parent/project/HEAD changed");
	if (w.root !== join(w.commonDir, "pi-workers", w.parent, w.id, "checkout") || !Array.isArray(w.files) || !w.files.length || w.files.length > 100) throw new Error("Worktree ownership/location mismatch");
	for (const p of [join(w.commonDir, "pi-workers"), join(w.commonDir, "pi-workers", w.parent), home(w), w.root, join(home(w), "blobs")])
		if (!lstatSync(p).isDirectory() || realpathSync(p) !== p) throw new Error("Worktree storage identity changed");
	for (const p of w.files) { workspacePath(w.root, p); workspacePath(w.parentRoot, p); if (secret(w.parentRoot, p)) throw new Error("Protected worktree ownership"); }
	if (realpathSync(git(w.root, ["rev-parse", "--show-toplevel"]).trim()) !== w.root || realpathSync(git(w.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()) !== w.commonDir || git(w.root, ["rev-parse", "HEAD"]).trim() !== w.head)
		throw new Error("Worktree Git identity changed");
	load(w);
	const cwd = resolve(w.root, relative(w.parentRoot, w.parentCwd)); if (!lstatSync(cwd).isDirectory() || realpathSync(cwd) !== cwd) throw new Error("Worktree cwd is missing or linked");
	return cwd;
}
export function createWorkspace(parentCwd: string, parent: string, id: string, files: string[]): Workspace {
	const lease = claimCheckout(parentCwd), deadline = Date.now() + 5000;
	const budget = () => { if (Date.now() > deadline) throw new Error("Worktree snapshot preparation exceeded its local time budget"); };
	try {
	if (!/^[\w-]{1,96}$/.test(parent) || !/^w[1-9]\d{0,8}$/.test(id) || !files.length || files.length > 100) throw new Error("Invalid worktree assignment");
	const repo = identity(parentCwd), owned = [...new Set(files.map(p => relative(repo.parentRoot, resolve(repo.parentCwd, p))))].sort();
	for (const p of owned) { workspacePath(repo.parentRoot, p); if (secret(repo.parentRoot, p)) throw new Error("Protected worktree ownership"); }
	const base = join(repo.commonDir, "pi-workers"), group = join(base, parent), storage = join(group, id);
	dir(base); dir(group); if (existsSync(storage)) throw new Error("Worktree storage already exists; retained work must not be overwritten"); dir(storage); dir(join(storage, "blobs"));
	const w: Workspace = { version: 1, parent, id, ...repo, root: join(storage, "checkout"), files: owned };
	const baseline: Record<string, State> = Object.create(null), content = new Map<string, Buffer>();
	const headPaths = git(repo.parentRoot, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
	const paths = names(repo.parentRoot, [...headPaths, ...owned]); let total = 0;
	for (const p of paths) {
		budget();
		if (secret(repo.parentRoot, p)) throw new Error("Protected HEAD/index paths prevent a worktree snapshot");
		const file = workspacePath(repo.parentRoot, p);
		try { const b = bytes(file); baseline[p] = b.state; total += b.data.length; if (total > MAX_TOTAL) throw new Error("Worktree snapshot exceeds its byte bound"); content.set(p, b.data); if (owned.includes(p)) blob(w, b.state, b.data); }
		catch (e: any) { if (e.code !== "ENOENT") throw e; baseline[p] = null; }
	}
	const m: Manifest = { version: 1, workspace: w, baseline, phase: "creating" }; save(m);
	git(repo.parentRoot, ["worktree", "add", "--detach", "--no-checkout", "--lock", "--reason", `Pi worker ${parent}/${id}: retained work`, w.root, w.head]); chmodSync(w.root, 0o700);
	git(w.root, ["read-tree", w.head]); // Index only; no checkout/smudge/filter/hook execution.
	const directories = new Set([w.root, home(w)]);
	for (const [p, data] of content) {
		budget();
		const file = workspacePath(w.root, p); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, data, { mode: baseline[p]!.mode, flag: "wx" }); chmodSync(file, baseline[p]!.mode); sync(file);
		let d = dirname(file); while (inside(w.root, d)) { directories.add(d); if (d === w.root) break; d = dirname(d); }
	}
	// Git's private administration is required for identity validation after a crash too.
	sync(join(w.root, ".git"));
	const admin = realpathSync(git(w.root, ["rev-parse", "--absolute-git-dir"]).trim());
	if (!inside(join(w.commonDir, "worktrees"), admin)) throw new Error("Unexpected worktree administration location");
	for (const name of ["HEAD", "index", "gitdir", "commondir", "locked"]) if (existsSync(join(admin, name))) sync(join(admin, name));
	sync(admin); sync(dirname(admin)); sync(w.commonDir);
	for (const d of [...directories].sort((a,b) => b.length - a.length)) sync(d);
	if (!same(identity(parentCwd), repo) || !same(names(repo.parentRoot, [...headPaths, ...owned]), paths) || paths.some(p => !same(state(repo.parentRoot, p), baseline[p])))
		throw new Error("Parent changed while taking the worktree snapshot; retained partial checkout was not launched");
	budget(); m.phase = "ready"; save(m); validateWorkspace(w, parentCwd, parent, id); return w;
	} finally { lease.release(); }
}
function inventory(root: string): string[] {
	const files: string[] = []; let entries = 0;
	function walk(dir: string, prefix: string) {
		for (const name of readdirSync(dir)) {
			if (!prefix && name === ".git") continue;
			if (++entries > 20000) throw new Error("Worktree integrity inventory exceeds its bound");
			const p = prefix ? `${prefix}/${name}` : name, full = workspacePath(root, p), s = lstatSync(full);
			if (s.isDirectory()) walk(full, p); else files.push(p);
		}
	}
	walk(root, ""); return files;
}
function changes(w: Workspace, m: Manifest): Change[] {
	const all = [...new Set([...inventory(w.root), ...Object.keys(m.baseline), ...w.files])].sort(), owned = new Set(w.files), result: Change[] = [];
	for (const p of all) {
		if (secret(w.root, p)) throw new Error("Protected worktree paths prevent import; contents were not inspected");
		const before = m.baseline[p] ?? null, after = state(w.root, p);
		if (same(before, after)) continue;
		if (!owned.has(p)) throw new Error(`Worktree changed a non-owned source path: ${p}`);
		result.push({ path: p, before, after });
	}
	return result;
}
export function previewImport(w: Workspace): ImportPlan {
	validateWorkspace(w, w.parentCwd); const m = load(w), list = changes(w, m);
	let diff = "";
	for (const c of list) {
		if (!same(state(w.parentRoot, c.path), c.before)) throw new Error(`Parent changed since the worktree baseline: ${c.path}`);
		const beforeBytes = c.before ? blob(w, c.before) : Buffer.alloc(0), afterBytes = c.after ? bytes(workspacePath(w.root, c.path)).data : Buffer.alloc(0);
		if (!isUtf8(beforeBytes) || !isUtf8(afterBytes)) throw new Error(`Import preview requires manual review of invalid UTF-8: ${c.path}`);
		const before = beforeBytes.toString("utf8"), after = afterBytes.toString("utf8");
		diff += `\n${c.path}: ${!c.before ? "add" : !c.after ? "delete" : "modify"} (${c.before?.mode.toString(8) ?? "absent"} → ${c.after?.mode.toString(8) ?? "absent"})\n`;
		// Exact before/after text rather than a HEAD diff (which would include pre-existing dirt).
		if (before.includes("\0") || after.includes("\0") || Buffer.byteLength(before + after) > 32768) throw new Error(`Import preview requires manual review of binary/large file: ${c.path}`);
		diff += `--- snapshot\n${before}\n+++ worker\n${after}\n`;
		if (Buffer.byteLength(diff) > 128 * 1024) throw new Error("Import preview exceeds its review bound; integrate manually");
	}
	return { workspace: w, changes: list, hash: hash(JSON.stringify(list)), diff: diff || "No owned-file changes relative to the snapshot." };
}
function prepare(w: Workspace, root: string, path: string, s: NonNullable<State>): string {
	const file = workspacePath(root, path);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); workspacePath(root, path);
	const temp = join(dirname(file), `.${basename(file)}.pi-import-${process.pid}`);
	writeFileSync(temp, blob(w, s), { mode: s.mode, flag: "wx" });
	try { chmodSync(temp, s.mode); sync(temp); return temp; } catch (e) { unlinkSync(temp); throw e; }
}
function put(w: Workspace, root: string, path: string, s: State, prepared?: string) {
	const file = workspacePath(root, path);
	if (!s) { if (existsSync(file)) unlinkSync(file); sync(dirname(file)); return; }
	const temp = prepared ?? prepare(w, root, path, s);
	try { renameSync(temp, file); sync(dirname(file)); } finally { if (existsSync(temp)) unlinkSync(temp); }
}
/** Call only after explicit human confirmation, under the parent checkout lease. */
export function applyImport(plan: ImportPlan): number {
	const w = plan.workspace, lease = claimCheckout(w.parentCwd);
	try {
	const current = previewImport(w);
	if (current.hash !== plan.hash || !same(current.changes, plan.changes)) throw new Error("Worktree changed after the import preview; review again");
	if (!plan.changes.length) return 0;
	const m = load(w);
	for (const c of plan.changes) if (c.after) blob(w, c.after, bytes(workspacePath(w.root, c.path)).data);
	const createdDirs = new Set<string>();
	for (const c of plan.changes) if (c.after) { let p = dirname(workspacePath(w.parentRoot, c.path)); while (!existsSync(p)) { createdDirs.add(p); p = dirname(p); } }
	m.import = { at: new Date().toISOString(), changes: plan.changes, state: "prepared", createdDirs: [...createdDirs].sort() }; save(m); // fsynced rollback blobs/journal precede parent writes.
	const done: Change[] = [], staged = new Map<string, string>();
	try {
		// Prepare every replacement before mutating any target; collisions/permissions fail early.
		for (const c of plan.changes) if (c.after) staged.set(c.path, prepare(w, w.parentRoot, c.path, c.after));
		for (const d of createdDirs) sync(dirname(d));
		for (const c of plan.changes) { if (!same(state(w.parentRoot, c.path), c.before)) throw new Error(`Parent raced import: ${c.path}`); done.push(c); put(w, w.parentRoot, c.path, c.after, staged.get(c.path)); }
		for (const c of plan.changes) if (!same(state(w.parentRoot, c.path), c.after)) throw new Error("Parent changed during import");
		for (const c of plan.changes) m.baseline[c.path] = c.after;
		delete m.import; save(m); return done.length;
	} catch (e) {
		let rolledBack = true;
		for (const c of done.reverse()) { try { const actual = state(w.parentRoot, c.path); if (same(actual, c.before)) continue; if (!same(actual, c.after)) throw new Error("Parent changed during rollback"); put(w, w.parentRoot, c.path, c.before); } catch { rolledBack = false; } }
		// Even a successful rollback leaves the journal: crash/failure recovery is deliberately manual.
		m.import = { at: new Date().toISOString(), changes: plan.changes, state: "uncertain", createdDirs: [...createdDirs].sort() }; save(m);
		throw new Error(`Import failed (${e}); ${rolledBack ? "parent file edits rolled back" : "rollback uncertain"}. Retained worktree/journal require inspection; created empty directories may remain.`);
	} finally { for (const tmp of staged.values()) if (existsSync(tmp)) unlinkSync(tmp); }
	} finally { lease.release(); }
}
