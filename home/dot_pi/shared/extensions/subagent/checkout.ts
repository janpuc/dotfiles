// Cross-process checkout coordination, shared by the profile tool guard and worker manager.
// A pre-spawn worker lease without a child witness is ambiguous after parent death: preserve it.
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquire, ownIdentity, ownerAlive, release, type LockOwner } from "../profile/session-lock.ts";
export interface CheckoutDelegation { path: string; owner: LockOwner }
interface Held { owner: LockOwner; refs: number; worker: boolean }
const held: Map<string, Held> = ((globalThis as any)[Symbol.for("pi-checkout.leases")] ??= new Map());
function location(cwd: string) {
	const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1" });
	const p = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir"], { env, encoding: "utf8", timeout: 2000 });
	if (p.error) throw new Error("Cannot establish checkout lease location");
	return join(realpathSync(p.status === 0 ? p.stdout.trim() : cwd), ".pi-checkout");
}
function owner(path: string): LockOwner | undefined {
	const dir = `${path}.lock`; if (!existsSync(dir)) return;
	if (!lstatSync(dir).isDirectory()) throw new Error("Checkout lease is linked/corrupt");
	const file = join(dir, "owner.json");
	if (!existsSync(file)) return;
	if (!lstatSync(file).isFile() || lstatSync(file).size > 4096) throw new Error("Checkout lease owner is linked/corrupt");
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { const o = JSON.parse(readFileSync(fd, "utf8")); if (!Number.isInteger(o.pid) || o.pid < 1 || !["host", "boot", "started", "at"].every(k => typeof o[k] === "string")) throw new Error("Invalid checkout lease witness"); return o; }
	finally { closeSync(fd); }
}
function publish(path: string, value: LockOwner) {
	const file = join(`${path}.lock`, "owner.json"), tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	try {
		const fd = openSync(tmp, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(tmp, file); const dir = openSync(`${path}.lock`, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
	} finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function claimCheckout(cwd: string, exclusive = false, worker = false, delegated?: CheckoutDelegation) {
	const path = location(cwd);
	if (delegated) {
		const o = owner(path);
		if (path !== delegated.path || !o || !ownerAlive(o) || o.at !== delegated.owner.at || o.host !== delegated.owner.host || o.boot !== delegated.owner.boot ||
			![process.pid, process.ppid].includes(o.pid) || process.ppid !== delegated.owner.pid || Number(process.env.PI_WORKER_PARENT_PID) !== delegated.owner.pid)
			throw new Error("Shared-checkout worker has no valid parent/child lease witness");
		return { delegation: delegated, handoff(_child: LockOwner) {}, release() {} };
	}
	const previous = held.get(path);
	if (previous) {
		if (exclusive || previous.worker) throw new Error("Checkout is already owned in this Pi process");
		previous.refs++;
	} else {
		const prior = owner(path);
		if (prior?.detach === "pi-worker-launch" && !ownerAlive(prior)) throw new Error("Checkout has an ambiguous pre-spawn worker lease; inspect before reclaiming");
		const me = ownIdentity("rpc"); if (worker) me.detach = "pi-worker-launch";
		const got = acquire(path, me, o => o.detach === "pi-worker-launch"); if (!got.ok) throw new Error(`Checkout is owned by another Pi process: ${got.reason}`);
		held.set(path, { owner: me, refs: 1, worker });
	}
	const entry = held.get(path)!; let closed = false;
	return { delegation: { path, owner: { ...entry.owner } },
		handoff(child: LockOwner) { if (closed || !entry.worker || held.get(path) !== entry) throw new Error("Invalid checkout lease handoff"); entry.owner = { ...child, at: entry.owner.at }; publish(path, entry.owner); },
		release() { if (!closed) { closed = true; if (--entry.refs === 0 && held.get(path) === entry) { release(path, entry.owner); held.delete(path); } } } };
}
