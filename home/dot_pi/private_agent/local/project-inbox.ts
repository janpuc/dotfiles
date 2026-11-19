// Watch the project inbox and the restart marker. Requests from other projects, replies and
// task folds reach the agent by themselves, one at a time and only when Pi is idle, so a
// run is never interrupted and nothing waits in a volatile follow-up queue. There is no prompt and no model call in
// this path. /inbox lists what arrived.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 30000;

export type InboxItem = {
	id: string;
	from: string;
	to: string;
	text: string;
	created: string;
	status: string;
	inReplyTo?: string;
};

export type InboxState = { delivered: Set<string>; promptOpen: boolean };

function atomicWrite(path: string, text: string) {
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

function inbox(folder: string) {
	return join(folder, ".agent/inbox");
}

function readItem(path: string): InboxItem | null {
	try {
		const item = JSON.parse(readFileSync(path, "utf8")) as InboxItem;
		return typeof item?.id === "string" && typeof item.from === "string" && typeof item.to === "string"
			&& typeof item.text === "string" && typeof item.status === "string" ? item : null;
	} catch {
		return null;
	}
}

export function openItems(folder: string, project: string): InboxItem[] {
	let names: string[];
	try {
		names = readdirSync(inbox(folder)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const item = readItem(join(inbox(folder), name));
		return item && item.status === "new" && item.to === project ? [item] : [];
	});
}

export function recentItems(folder: string, project: string, count = 8): InboxItem[] {
	let names: string[];
	try {
		names = readdirSync(inbox(folder)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const item = readItem(join(inbox(folder), name));
		return item && item.to === project ? [item] : [];
	}).slice(-count);
}

function setStatus(folder: string, item: InboxItem, status: string) {
	const path = join(inbox(folder), `${item.id}.json`);
	if (!existsSync(path)) return false;
	atomicWrite(path, `${JSON.stringify({ ...item, status, handledAt: new Date().toISOString() }, null, 2)}\n`);
	return true;
}

function message(item: InboxItem, project: string) {
	const head = item.inReplyTo
		? `Reply ${item.id} from ${item.from} to your request ${item.inReplyTo}.`
		: item.from === project ? `Fold ${item.id} from one of your tasks.` : `Request ${item.id} from ${item.from}.`;
	const tail = item.inReplyTo || item.from === project ? "" : `\n\nWhen done, answer with: agent reply ${project} ${item.id} <text>`;
	return `${head}\n\n${item.text}${tail}`;
}

/** Hand the oldest new item to an idle agent and mark it accepted. The next poll after the
 * run settles hands over the next one. */
export function deliverOpen(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	project: string,
	folder: string,
	ctx: ExtensionContext,
	state: InboxState,
) {
	if (state.promptOpen || !ctx.isIdle() || ctx.hasPendingMessages()) return;
	for (const item of openItems(folder, project)) {
		if (state.delivered.has(item.id)) continue;
		if (!setStatus(folder, item, "accepted")) continue;
		state.delivered.add(item.id);
		try {
			pi.sendUserMessage(message(item, project));
			return;
		} catch (error) {
			setStatus(folder, item, "new");
			state.delivered.delete(item.id);
			ctx.ui.notify(`inbox: could not hand ${item.id} to the agent: ${error}`, "error");
		}
	}
}

function requestRestart(project: string, folder: string, ctx: ExtensionContext, state: InboxState) {
	if (state.promptOpen) return false;
	if (ctx.mode !== "tui" || !ctx.hasUI) return false;
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
	const marker = join(folder, ".agent/restart-requested");
	if (!existsSync(marker)) return false;
	// The marker stays for the runner, which relaunches Pi on the same session and clears it.
	ctx.ui.notify("Restarting to load new config", "info");
	ctx.shutdown();
	return true;
}

export default function (pi: ExtensionAPI) {
	const project = process.env.PI_PROJECT;
	// A child inherits PI_PROJECT but must never answer for the project it runs in.
	if (!project || process.env.PI_TASK || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") return;
	const folder = process.env.PI_PROJECT_DIR;
	if (!folder) throw new Error("PI_PROJECT_DIR is required for the project inbox");
	const state: InboxState = { delivered: new Set(), promptOpen: false };
	let timer: ReturnType<typeof setInterval> | undefined;

	let fetching = false;
	const poll = async (ctx: ExtensionContext) => {
		if (requestRestart(project, folder, ctx, state)) return;
		if (project === "work" && !fetching) {
			fetching = true;
			try {
				const result = await pi.exec(join(homedir(), ".local/bin/agent"), ["--fetch-replies"], { timeout: 20000 });
				if (result.code !== 0) ctx.ui.notify("Work reply fetch failed, check the restricted aether inbox key", "warning");
			} catch {
				ctx.ui.notify("Work reply fetch failed, replies remain on aether", "warning");
			} finally {
				fetching = false;
			}
		}
		deliverOpen(pi, project, folder, ctx, state);
	};

	pi.on("session_start", (_event, ctx) => {
		state.delivered.clear();
		state.promptOpen = false;
		if (timer) clearInterval(timer);
		timer = setInterval(() => poll(ctx), POLL_MS);
		timer.unref();
	});
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); });
	// Another extension's dialog blocks a restart and an inbox prompt until it closes.
	pi.on("ui_prompt_start", () => { state.promptOpen = true; });
	pi.on("ui_prompt_end", () => { state.promptOpen = false; });
	pi.on("agent_settled", (_event, ctx) => poll(ctx));
	pi.registerCommand("inbox", {
		description: "List recent cross-project requests, replies and folds",
		handler: async (_args, ctx) => {
			if (project === "work") await poll(ctx);
			const items = recentItems(folder, project);
			ctx.ui.notify(items.length
				? items.map((item) => `${item.id} ${item.inReplyTo ? "reply" : "request"} from ${item.from}: ${item.status}`).join("\n")
				: "Inbox is empty", "info");
		},
	});
}
