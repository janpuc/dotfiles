// A pi-subagents inspector for Rex: Fleet's inspect action (and subagent inspector.*) works when
// Pi runs in Rex, where pi-subagents 0.84 knows only Herdr, Ghostty and tmux. No published one
// existed when this was written (2026-11-02); drop this file if pi-subagents ships its own.
//
// - A child placed in a Rex tab (machine local, sisyphus or aether) already has its tab: inspect
//   brings the Rex app on this Mac to it, on whichever server it runs. pi-subagents owns that tab,
//   so close leaves it alone.
// - Any other background run gets pi-subagents' own inspector screen in a new tab of this session,
//   recorded in <asyncDir>/inspectors/rex[-<index>].json so status and close find it again.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const REX = process.env.REX_BIN_DIR ? path.join(process.env.REX_BIN_DIR, "rex") : "rex";
const JOURNAL = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi/agent"), "pi-subagents/herdr-run-journal");

type Target = { runId: string; asyncDir: string; index?: number };
type Context = { env: NodeJS.ProcessEnv; target: Target };
type Launch = { executable: string; argv: string[] };
type Placed = { machineId: string; session: string; tabId: string };
type Binding = { schemaVersion: 1; kind: "rex-inspector"; runId: string; asyncDir: string; index?: number; session: string; windowId: string; blockId: string };

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [] } };
}

async function rex(args: string[]): Promise<string> {
	return (await run(REX, args, { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
}

/** The newest journal entry of a run that pi-subagents placed in a Rex tab. */
function placed(target: Target): Placed | undefined {
	let newest: { at: number; identity: Placed } | undefined;
	try {
		for (const name of fs.readdirSync(JOURNAL)) {
			if (!name.startsWith(`${target.runId}_`) || !name.endsWith(".json")) continue;
			const entry = JSON.parse(fs.readFileSync(path.join(JOURNAL, name), "utf8"));
			const id = entry?.identity;
			if (typeof id?.machineId !== "string" || typeof id.session !== "string" || typeof id.tabId !== "string") continue;
			if (!newest || entry.updatedAt > newest.at) newest = { at: entry.updatedAt ?? 0, identity: id };
		}
	} catch {}
	return newest?.identity;
}

function bindingPath(target: Target) {
	return path.join(target.asyncDir, "inspectors", `rex${target.index === undefined ? "" : `-${target.index}`}.json`);
}

function binding(target: Target): Binding | undefined {
	try {
		const b = JSON.parse(fs.readFileSync(bindingPath(target), "utf8"));
		return b?.kind === "rex-inspector" && b.runId === target.runId && b.index === target.index ? b : undefined;
	} catch {
		return undefined;
	}
}

/** `-S <host>` for a machine on another Rex server: its saved host, matched case-insensitively. */
async function serverArgs(machineId: string): Promise<string[]> {
	if (machineId === "local") return [];
	try {
		const hosts = JSON.parse(await rex(["hosts", "--json"]));
		const labels: string[] = (hosts.hosts ?? []).map((h: { host?: { label?: string } }) => h.host?.label).filter(Boolean);
		return ["-S", labels.find((l) => l.toLowerCase() === machineId.toLowerCase()) ?? machineId];
	} catch {
		return ["-S", machineId];
	}
}

/** The label of this Mac's Rex app, which every server it is connected to lists as a client. */
async function appLabel(): Promise<string | undefined> {
	const listed = JSON.parse(await rex(["client", "ls", "--json"]));
	return listed.clients?.find((c: { info?: { kind?: string } }) => c.info?.kind === "app")?.info?.label;
}

/** Show a window in the Rex app on this Mac. */
async function show(server: string[], session: string, windowId: string) {
	const app = await appLabel();
	if (!app) throw new Error("no Rex app is connected to this Mac's server");
	await rex([...server, "-C", app, "do", "session.select", `session_id=${session}`, `window_id=${windowId}`]);
}

async function blockAlive(b: Binding) {
	try {
		await rex(["block", "call", "-s", b.session, "-b", b.blockId, "process"]);
		return true;
	} catch {
		return false;
	}
}

const rexInspector = {
	name: "rex",
	available: (context: Context) => context.env.TERM_PROGRAM === "rex" && Boolean(context.env.REX_SESSION?.trim()),
	owns: (context: Context) => placed(context.target) !== undefined || binding(context.target) !== undefined,

	async open(context: Context, launch: Launch, params: { focus?: boolean }) {
		const { target } = context;
		try {
			const p = placed(target);
			if (p) {
				const server = await serverArgs(p.machineId);
				const windows = await rex([...server, "window", "ls", "-s", p.session, "--json"]);
				if (!windows.includes(p.tabId)) return result(`Run ${target.runId}'s Rex tab on ${p.machineId} is closed.`, true);
				await show(server, p.session, p.tabId);
				return result(`Showing the Rex tab of run ${target.runId} on ${p.machineId}.`);
			}
			const existing = binding(target);
			if (existing && (await blockAlive(existing))) {
				if (params.focus !== false) await show([], existing.session, existing.windowId);
				return result(`The Rex inspector tab for run ${target.runId} is already open.`);
			}
			const session = context.env.REX_SESSION as string;
			const opened = JSON.parse(await rex(["run", "-s", session, "--label", `inspect-${target.runId.slice(0, 8)}`, "--shell=none", `--focus=${params.focus !== false}`, "--json", "--", launch.executable, ...launch.argv]));
			const b: Binding = { schemaVersion: 1, kind: "rex-inspector", runId: target.runId, asyncDir: target.asyncDir, ...(target.index !== undefined ? { index: target.index } : {}), session, windowId: opened.window_id, blockId: opened.block_ids[0] };
			fs.mkdirSync(path.dirname(bindingPath(target)), { recursive: true, mode: 0o700 });
			fs.writeFileSync(bindingPath(target), JSON.stringify(b), { mode: 0o600 });
			return result(`Opened a Rex inspector tab for run ${target.runId}.`);
		} catch (error) {
			return result(`Rex inspector error: ${error instanceof Error ? error.message : String(error)}`, true);
		}
	},

	async status(context: Context) {
		const p = placed(context.target);
		if (p) return result(`Run ${context.target.runId} runs in Rex tab ${p.tabId} on ${p.machineId}.`);
		const b = binding(context.target);
		if (!b) return result(`No Rex inspector for run ${context.target.runId}.`);
		return result(`Rex inspector tab ${b.windowId} for run ${b.runId} is ${(await blockAlive(b)) ? "open" : "closed"}.`);
	},

	async close(context: Context) {
		if (placed(context.target)) return result(`Run ${context.target.runId} lives in its own Rex tab; pi-subagents closes it, not the inspector.`);
		const b = binding(context.target);
		if (!b) return result(`No Rex inspector for run ${context.target.runId}.`);
		try {
			await rex(["window", "close", "-s", b.session, b.windowId]);
		} catch {}
		fs.rmSync(bindingPath(context.target), { force: true });
		return result(`Closed the Rex inspector tab for run ${b.runId}.`);
	},
};

export default function (pi: ExtensionAPI) {
	let registration: { dispose(): void } | undefined;
	pi.on("session_start", () => {
		registration?.dispose();
		registration = undefined;
		const request: { version: 1; plugin: typeof rexInspector; result?: { ok: boolean; registration?: { dispose(): void }; error?: Error } } = { version: 1, plugin: rexInspector };
		pi.events.emit("pi-subagents:inspector-register:v1", request);
		// No result inside a subagent child, where pi-subagents registers nothing.
		if (request.result?.ok) registration = request.result.registration;
		else if (request.result) console.error(`rex-inspector: ${request.result.error?.message}`);
	});
	pi.on("session_shutdown", () => registration?.dispose());
}
