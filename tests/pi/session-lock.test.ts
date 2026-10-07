// Unit tests for session-lock.ts (one Pi process per session file) and detach.ts (aether's
// detachable terminal Pi). Locks live in a throwaway directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquire, holder, inUseMessage, ownIdentity, ownerAlive, processStart, release, type LockOwner } from "../../home/dot_pi/shared/extensions/profile/session-lock.ts";
import { detachInfo, terminalSetup } from "../../home/dot_pi/shared/extensions/profile/detach.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-lock-test-"));
let n = 0;
const session = () => join(dir, `s${++n}.jsonl`);
const me = ownIdentity("tui");
/** A real pid that has exited, with this host and boot, so it reads as a dead owner. */
const deadPid = (() => spawnSync(process.execPath, ["-e", "0"]).pid!)();
const ghost = (over: Partial<LockOwner> = {}): LockOwner => ({ ...me, pid: deadPid, started: "1", ...over });
const plant = (file: string, owner: LockOwner) => {
	mkdirSync(`${file}.lock`);
	writeFileSync(join(`${file}.lock`, "owner.json"), JSON.stringify(owner));
};

test("the first process takes the lock, re-taking one's own lock works, release frees it", () => {
	const f = session();
	assert.deepEqual(acquire(f, me), { ok: true });
	assert.deepEqual(acquire(f, me), { ok: true }, "same process (e.g. after /reload)");
	assert.equal(holder(f)?.pid, process.pid);
	release(f, me);
	assert.equal(existsSync(`${f}.lock`), false);
	assert.equal(existsSync(f), false, "the session file itself is never created");
});

test("a live owner keeps the lock; the refusal names where the session is open", () => {
	const f = session();
	const live = { ...me, pid: process.ppid, started: processStart(process.ppid), mode: "rpc" as const };
	plant(f, live);
	const r = acquire(f, me);
	assert.equal(r.ok, false);
	assert.equal(!r.ok && r.owner?.pid, process.ppid);
	assert.match(inUseMessage(f, live, "held"), /in T3 Code \(pi --mode rpc/);
	assert.match(inUseMessage(f, { ...live, mode: "tui", detach: "p123" }, "held"), /pi-attach p123/);
	assert.match(inUseMessage(f, { ...live, mode: "print" }, "held"), /wait for it to finish/);
	release(f, me);
	assert.equal(existsSync(`${f}.lock`), true, "release never removes another owner's lock");
});

test("a dead owner, a reused pid or a previous boot is taken over", () => {
	for (const owner of [ghost(), { ...me, pid: process.pid, started: "not-my-start-time" }, ghost({ pid: process.ppid, boot: "previous-boot" })]) {
		const f = session();
		plant(f, owner);
		assert.equal(ownerAlive(owner), false);
		assert.deepEqual(acquire(f, me), { ok: true });
		assert.equal(JSON.parse(readFileSync(join(`${f}.lock`, "owner.json"), "utf8")).pid, process.pid);
	}
});

test("another host, an unreadable owner or a lock still being created is left alone", () => {
	const remote = session();
	plant(remote, ghost({ host: "elsewhere" }));
	assert.equal(acquire(remote, me).ok, false);
	const broken = session();
	mkdirSync(`${broken}.lock`);
	writeFileSync(join(`${broken}.lock`, "owner.json"), "{not json");
	assert.match((acquire(broken, me) as any).reason, /cannot be read/);
	const fresh = session();
	mkdirSync(`${fresh}.lock`);
	assert.match((acquire(fresh, me) as any).reason, /opening this session right now/);
	const old = session();
	mkdirSync(`${old}.lock`);
	const past = new Date(Date.now() - 60_000);
	utimesSync(`${old}.lock`, past, past);
	assert.deepEqual(acquire(old, me), { ok: true }, "an abandoned half-created lock is taken over");
});

test("a takeover left behind by a crashed process does not block forever", () => {
	const f = session();
	plant(f, ghost());
	mkdirSync(`${f}.lock.takeover`);
	const past = new Date(Date.now() - 60_000);
	utimesSync(`${f}.lock.takeover`, past, past);
	assert.deepEqual(acquire(f, me), { ok: true });
	assert.equal(existsSync(`${f}.lock.takeover`), false);
});

test("detach: only a well-formed id is used; the reattach setup follows the TUI's state", () => {
	assert.deepEqual(detachInfo({ PI_DETACH_ID: "p1-2", PI_DETACH_DIR: "/run/user/1/pi" }), { id: "p1-2", dir: "/run/user/1/pi" });
	assert.equal(detachInfo({ PI_DETACH_ID: "../x", PI_DETACH_DIR: "/d" }), undefined);
	assert.equal(detachInfo({ PI_DETACH_ID: "p1" }), undefined);
	const full = terminalSetup({ altScreenActive: true, mouseEnabled: true, terminal: { kittyProtocolActive: true } });
	assert.ok(full.startsWith("\x1b[?1049h\x1b[?7l\x1b[?1000h"), "alternate screen, no autowrap, mouse");
	assert.ok(full.includes("\x1b[?2004h") && full.includes("\x1b[>7u"), "bracketed paste, kitty keyboard flags");
	const plain = terminalSetup({ altScreenActive: false, terminal: { modifyOtherKeysActive: true } });
	assert.ok(!plain.includes("\x1b[?1049h") && plain.includes("\x1b[>4;2m"));
});
