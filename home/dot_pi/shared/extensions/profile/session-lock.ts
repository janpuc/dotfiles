// One Pi process per session file. T3 Code runs `pi --mode rpc` on the same session files as
// terminal Pi, and Pi itself has no lock, so two processes could append to one conversation.
//
// The lock is a directory next to the session file (`<file>.lock/`, created atomically with
// mkdir) holding owner.json. An owner counts as gone only when its process is: same boot, and
// the pid is dead or now belongs to a process that started at another time (pid reuse). A lock
// held on another host, or one that cannot be read, is treated as held. Taking over a dead
// owner's lock happens under a second atomic directory (`<file>.lock.takeover`), and the owner
// is re-checked there, so two processes can never both take it over.
//
// This is a guard, not a hard lock: Pi writes a few things before extensions start (`--name`,
// migrating an old session file), and `--no-extensions` skips it.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface LockOwner {
	pid: number;
	host: string;
	/** Boot identity: a pid is only comparable within one boot. */
	boot: string;
	/** Process start identity, so a reused pid is not mistaken for the owner. */
	started: string;
	mode: "tui" | "rpc" | "print";
	/** dtach session id when the TUI runs detachable (aether), for `pi-attach <id>`. */
	detach?: string;
	at: string;
}

export type Acquired = { ok: true } | { ok: false; owner?: LockOwner; reason: string };

/** Creation of a lock directory that has no owner.json yet is still in progress for this long. */
const PUBLISH_GRACE_MS = 10_000;

const lockDir = (file: string) => `${file}.lock`;
const ownerFile = (file: string) => join(lockDir(file), "owner.json");

function run(cmd: string, args: string[]): string {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000 });
	return r.status === 0 ? r.stdout.trim() : "";
}

let ownBoot: string | undefined;
export function bootId(): string {
	if (ownBoot === undefined) {
		try {
			ownBoot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		} catch {
			ownBoot = run("sysctl", ["-n", "kern.boottime"]).replace(/^.*sec = (\d+).*$/, "$1") || "unknown";
		}
	}
	return ownBoot;
}

/** When a process started, as an opaque string; "" when it does not exist. */
export function processStart(pid: number): string {
	try {
		// Field 22 of /proc/<pid>/stat, after the parenthesised command name (which may contain spaces).
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
	} catch {
		return process.platform === "linux" ? "" : run("ps", ["-o", "lstart=", "-p", String(pid)]);
	}
}

export function ownIdentity(mode: LockOwner["mode"], detach?: string): LockOwner {
	return { pid: process.pid, host: hostname(), boot: bootId(), started: processStart(process.pid), mode, ...(detach ? { detach } : {}), at: new Date().toISOString() };
}

/** Whether the recorded owner may still be running. Unknown counts as running. */
export function ownerAlive(o: LockOwner): boolean {
	if (o.host !== hostname() || o.boot !== bootId()) return o.host !== hostname();
	try {
		process.kill(o.pid, 0);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	const started = processStart(o.pid);
	return !started || !o.started || started === o.started;
}

const sameProcess = (a: LockOwner, b: LockOwner) => a.pid === b.pid && a.host === b.host && a.boot === b.boot && a.started === b.started;

function readOwner(file: string): LockOwner | "missing" | "unreadable" {
	try {
		const o = JSON.parse(readFileSync(ownerFile(file), "utf8"));
		return typeof o?.pid === "number" && typeof o?.host === "string" ? (o as LockOwner) : "unreadable";
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
	}
}

function publish(file: string, me: LockOwner): void {
	const tmp = join(lockDir(file), `.owner.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
	renameSync(tmp, ownerFile(file));
}

function ageMs(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return Infinity;
	}
}

/** Take the lock on `file` for `me`, or say who holds it. Re-taking one's own lock succeeds. */
export function acquire(file: string, me: LockOwner, retainOwner?: (owner: LockOwner) => boolean): Acquired {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			mkdirSync(lockDir(file), { mode: 0o700 });
			publish(file, me);
			return { ok: true };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: `cannot create ${lockDir(file)}: ${(e as Error).message}` };
		}
		const owner = readOwner(file);
		if (owner === "unreadable") return { ok: false, reason: `${ownerFile(file)} cannot be read; remove ${lockDir(file)} if no Pi has this session open` };
		if (owner === "missing") {
			if (ageMs(lockDir(file)) < PUBLISH_GRACE_MS) return { ok: false, reason: "another Pi is opening this session right now" };
		} else {
			// Checkout launch witnesses can hide an as-yet-unpublished child. Keep this
			// rule inside reclamation (also under its mutex), not in a racy caller check.
			if (retainOwner?.(owner)) return { ok: false, owner, reason: "owner requires explicit inspection before reclaim" };
			if (sameProcess(owner, me)) {
				publish(file, me);
				return { ok: true };
			}
			if (ownerAlive(owner)) return { ok: false, owner, reason: "held" };
		}
		// The owner is gone: take over, serialised so that only one process does it.
		const mutex = `${lockDir(file)}.takeover`;
		try {
			mkdirSync(mutex, { mode: 0o700 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: (e as Error).message };
			// A takeover that died midway leaves its mutex behind; it never takes long.
			if (ageMs(mutex) > PUBLISH_GRACE_MS) rmSync(mutex, { recursive: true, force: true });
			continue;
		}
		try {
			const again = readOwner(file);
			const stillDead = again === "missing" ? ageMs(lockDir(file)) >= PUBLISH_GRACE_MS : again !== "unreadable" && !retainOwner?.(again) && !ownerAlive(again);
			if (stillDead) rmSync(lockDir(file), { recursive: true, force: true });
		} finally {
			rmSync(mutex, { recursive: true, force: true });
		}
	}
	return { ok: false, reason: "the lock kept changing hands; try again" };
}

/** Drop the lock if this process holds it; never removes another owner's lock. */
export function release(file: string, me: LockOwner): void {
	const owner = readOwner(file);
	if (owner !== "missing" && owner !== "unreadable" && sameProcess(owner, me)) rmSync(lockDir(file), { recursive: true, force: true });
}

/** Who holds `file`'s lock, if a live process does. */
export function holder(file: string): LockOwner | undefined {
	const owner = readOwner(file);
	return owner !== "missing" && owner !== "unreadable" && ownerAlive(owner) ? owner : undefined;
}

/** What to tell someone who tried to open a session that is in use. */
export function inUseMessage(file: string, owner: LockOwner | undefined, reason: string): string {
	if (!owner) return `pi-profile: ${file} is locked (${reason}).`;
	const where =
		owner.detach ? `in a detached terminal session (pid ${owner.pid}); attach to it with: pi-attach ${owner.detach}`
		: owner.mode === "rpc" ? `in T3 Code (pi --mode rpc, pid ${owner.pid}); continue it there, or stop that thread first`
		: owner.mode === "print" ? `by a pi -p run (pid ${owner.pid}); wait for it to finish`
		: owner.host !== hostname() ? `on ${owner.host} (pid ${owner.pid})`
		: `in another terminal (pid ${owner.pid}); continue there, or quit that Pi first`;
	return `pi-profile: this session is already open ${where}. Two Pi processes writing one session would interleave it, so this one stops here.`;
}
