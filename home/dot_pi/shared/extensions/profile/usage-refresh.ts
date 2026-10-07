// Detached usage refresher: `node usage-refresh.ts <agent-dir> <profile> <pool>...`.
// Spawned by the profile extension so Pi never waits on the network or keeps running after a
// print-mode answer; writes <agent-dir>/usage.json, which every Pi process of the profile reads.
// A lock file keeps concurrent sessions from probing at the same time.

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { refresh } from "./usage-sources.ts";

async function main(): Promise<number> {
	const [agentDir, profile, ...pools] = process.argv.slice(2);
	if (!agentDir || !profile || !pools.length) return 2;
	const lock = join(agentDir, "usage.json.lock");
	try {
		if (Date.now() - statSync(lock).mtimeMs < 90_000) return 0;
		unlinkSync(lock);
	} catch {
		// no lock
	}
	try {
		closeSync(openSync(lock, "wx"));
	} catch {
		return 0;
	}
	try {
		await refresh(join(agentDir, "usage.json"), agentDir, profile, pools);
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// already gone
		}
	}
	return 0;
}

main().then(
	(code) => process.exit(code),
	() => process.exit(1),
);
