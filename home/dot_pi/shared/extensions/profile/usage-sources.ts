// Fetch subscription usage and keep it in a per-profile cache (<agent-dir>/usage.json) that
// routing reads synchronously. Every source reads usage with the credential its own client
// already holds: Claude Code (Agent SDK, per CLAUDE_CONFIG_DIR), the Codex CLI's app-server,
// and Pi's own OpenCode Go and MiniMax keys. Nothing is extracted from a credential store.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromClaude, fromCodex, fromMinimax, fromOpencodeGo, mergeUsage, type SubUsage } from "./usage.ts";

export type UsageCache = Record<string, SubUsage>;

// claude-usage.mjs sits beside this file in the managed extension directory.
const CLAUDE_USAGE_SCRIPT = join(homedir(), ".pi", "shared", "extensions", "profile", "claude-usage.mjs");

export function readCache(file: string): UsageCache {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

export function writeCache(file: string, cache: UsageCache): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

/** Run a command, feed it stdin lines, collect stdout until `done` says so or the timeout hits. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number; done?: (out: string) => boolean }): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		const finish = (err?: Error) => {
			clearTimeout(timer);
			proc.kill("SIGTERM");
			err ? reject(err) : resolve(out);
		};
		const timer = setTimeout(() => finish(new Error(`${cmd} timed out`)), opts.timeoutMs);
		proc.on("error", (e) => finish(e));
		proc.stdout.on("data", (c) => {
			out += c;
			if (opts.done?.(out)) finish();
		});
		proc.on("close", () => finish());
		if (opts.input) proc.stdin.write(opts.input);
	});
}

async function claude(agentDir: string, label: string): Promise<SubUsage> {
	const sdk = join(agentDir, "npm", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
	if (!existsSync(sdk)) throw new Error("pi-claude-bridge's Agent SDK is not installed in this profile");
	const out = await run(process.execPath, [CLAUDE_USAGE_SCRIPT, sdk], { timeoutMs: 45_000 });
	const r = JSON.parse(out);
	if (r.error) throw new Error(r.error);
	if (!r.rate_limits_available) throw new Error("no plan limits for this login");
	return fromClaude(r, new Date().toISOString(), label);
}

async function chatgpt(): Promise<SubUsage> {
	const input =
		[
			{ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "pi-usage", title: "pi usage", version: "1.0.0" } } },
			{ jsonrpc: "2.0", method: "initialized" },
			{ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read" },
		]
			.map((m) => JSON.stringify(m))
			.join("\n") + "\n";
	const out = await run("codex", ["app-server"], { input, timeoutMs: 30_000, done: (o) => /"id":1[,}]/.test(o) });
	const line = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).find((m) => m?.id === 1);
	if (!line?.result) throw new Error(`codex app-server: ${line?.error?.message ?? "no answer"}`);
	return fromCodex(line.result, new Date().toISOString());
}

async function getJson(url: string, key: string | undefined, what: string): Promise<any> {
	if (!key) throw new Error(`no ${what} key in this process (run ai-sync)`);
	const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
	if (!r.ok) throw new Error(`${what} usage: HTTP ${r.status}`);
	return r.json();
}

export const SOURCES: Record<string, (agentDir: string, profile: string) => Promise<SubUsage>> = {
	claude: (agentDir, profile) => claude(agentDir, profile === "work" ? "Claude (enterprise)" : "Claude"),
	chatgpt: () => chatgpt(),
	"opencode-go": async () => fromOpencodeGo(await getJson("https://opencode.ai/zen/go/v1/usage", process.env.OPENCODE_API_KEY, "OpenCode Go"), new Date().toISOString()),
	minimax: async () => fromMinimax(await getJson("https://api.minimax.io/v1/token_plan/remains", process.env.MINIMAX_API_KEY, "MiniMax"), new Date().toISOString()),
};

/**
 * Refresh the given subscriptions in parallel and merge into the cache file. A failed source
 * keeps its last good windows (marked with the error) so one outage never blanks the rest.
 */
export async function refresh(file: string, agentDir: string, profile: string, subs: string[]): Promise<UsageCache> {
	const results = await Promise.allSettled(subs.map((s) => SOURCES[s]?.(agentDir, profile) ?? Promise.reject(new Error(`no source for ${s}`))));
	const cache = readCache(file);
	subs.forEach((s, i) => {
		const r = results[i];
		cache[s] = mergeUsage(cache[s], s, r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
	});
	writeCache(file, cache);
	return cache;
}
