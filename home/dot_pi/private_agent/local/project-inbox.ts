// Watch the project inbox and the restart marker while Pi is idle. A cross-project request
// never reaches the agent without Jan choosing "Take this on now" in the tab: in print, json
// or rpc mode an item stays new. There is no model call in this path, the prompt and the
// accepted message are plain text.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 30000;
const FULL_PCT = 85;
const ACCEPT = "Take this on now";
const LATER = "Later";
const DECLINE = "Decline";
const DECLINE_TEXT = "Declined, no work was done on this request.";

export type InboxItem = {
	id: string;
	from: string;
	to: string;
	text: string;
	created: string;
	status: string;
	inReplyTo?: string;
};

export type InboxState = { offered: Set<string>; busy: boolean; promptOpen: boolean };

type Usage = { text: string; full: boolean };

function atomicWrite(path: string, text: string) {
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

function requestId() {
	const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
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

function setStatus(folder: string, item: InboxItem, status: string) {
	const path = join(inbox(folder), `${item.id}.json`);
	if (!existsSync(path)) return false;
	atomicWrite(path, `${JSON.stringify({ ...item, status, handledAt: new Date().toISOString() }, null, 2)}\n`);
	return true;
}

// pi-usage's cache: the claude pool's 5h and week windows. Missing or partial data is fine.
export function usage(): Usage {
	let pool: { windows?: { name?: string; usedPct?: number }[] } | undefined;
	try {
		pool = JSON.parse(readFileSync(join(homedir(), ".pi/agent/usage.json"), "utf8")).claude;
	} catch {
		return { text: "Claude usage unknown", full: false };
	}
	const windows = Array.isArray(pool?.windows) ? pool.windows : [];
	const window = (name: string) => windows.find((entry) => entry?.name === name && typeof entry.usedPct === "number");
	const five = window("5h");
	const week = window("week");
	if (!five && !week) return { text: "Claude usage unknown", full: false };
	const parts = [
		five ? `5h ${Math.round(five.usedPct ?? 0)} percent` : "5h unknown",
		week ? `week ${Math.round(week.usedPct ?? 0)} percent` : "week unknown",
	];
	const full = (five?.usedPct ?? 0) >= FULL_PCT || (week?.usedPct ?? 0) >= FULL_PCT;
	return { text: `Claude usage ${parts.join(", ")}${full ? `, at or above ${FULL_PCT} percent so Later is first` : ""}`, full };
}

function prompt(item: InboxItem, rate: Usage) {
	const head = item.inReplyTo
		? `Reply ${item.id} from ${item.from} to your request ${item.inReplyTo}`
		: `Request ${item.id} from ${item.from}`;
	const text = item.text.length > 2000 ? `${item.text.slice(0, 2000)}\n(truncated)` : item.text;
	return `${head}\n${rate.text}\n\n${text}`;
}

function message(item: InboxItem, project: string) {
	const head = item.inReplyTo
		? `Reply ${item.id} from ${item.from} to your request ${item.inReplyTo}. Jan accepted it in the inbox prompt.`
		: `Request ${item.id} from ${item.from}. Jan accepted it in the inbox prompt.`;
	const tail = item.inReplyTo || item.from === project ? "" : `\n\nWhen done, answer with: agent reply ${project} ${item.id} <text>`;
	return `${head}\n\n${item.text}${tail}`;
}

// A declined request gets an automatic reply. A declined reply gets none, so two projects
// cannot bounce declines between their inboxes.
function replyDecline(item: InboxItem, project: string) {
	const root = process.env.PI_PROJECT_ROOT;
	if (!root) throw new Error("PI_PROJECT_ROOT is required for inbox replies");
	const recipient = item.from === "jan" ? "main" : item.from;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(recipient)) throw new Error("Invalid inbox sender");
	if (project === "work" && recipient !== "work") {
		execFileSync("python3", [join(homedir(), ".local/bin/agent-run"), "--launch", "reply", project, item.id, DECLINE_TEXT], { timeout: 20000 });
		return;
	}
	const target = recipient === "work" && project !== "work"
		? join(homedir(), ".local/state/agents/remote-inbox/work") : inbox(join(root, recipient));
	const reply: InboxItem = {
		id: requestId(), from: project, to: recipient, text: DECLINE_TEXT,
		created: new Date().toISOString(), status: "new", inReplyTo: item.id,
	};
	mkdirSync(target, { recursive: true });
	atomicWrite(join(target, `${reply.id}.json`), `${JSON.stringify(reply, null, 2)}\n`);
}

export async function offerOpen(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	project: string,
	folder: string,
	ctx: ExtensionContext,
	state: InboxState,
) {
	if (state.busy || state.promptOpen) return;
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
	const items = openItems(folder, project).filter((item) => !state.offered.has(item.id));
	if (!items.length) return;
	state.busy = true;
	try {
		for (const item of items) {
			state.offered.add(item.id);
			const rate = usage();
			const options = rate.full ? [LATER, ACCEPT, DECLINE] : [ACCEPT, LATER, DECLINE];
			const choice = await ctx.ui.select(prompt(item, rate), options);
			if (choice === ACCEPT) {
				if (!setStatus(folder, item, "accepted")) continue;
				try {
					pi.sendUserMessage(message(item, project), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				} catch (error) {
					setStatus(folder, item, "new");
					ctx.ui.notify(`inbox: could not hand ${item.id} to the agent: ${error}`, "error");
				}
			} else if (choice === DECLINE) {
				if (setStatus(folder, item, "declined") && !item.inReplyTo) {
					try {
						replyDecline(item, project);
					} catch (error) {
						ctx.ui.notify(`inbox: declined ${item.id} but could not reply to ${item.from}: ${error}`, "error");
					}
				}
			}
			// Later and a cancelled dialog leave the item new and stop offering it until /inbox.
		}
	} finally {
		state.busy = false;
	}
}

function requestRestart(project: string, folder: string, ctx: ExtensionContext, state: InboxState) {
	if (state.busy || state.promptOpen) return false;
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
	const state: InboxState = { offered: new Set(), busy: false, promptOpen: false };
	let timer: ReturnType<typeof setInterval> | undefined;

	let fetching = false;
	const poll = async (ctx: ExtensionContext) => {
		if (requestRestart(project, folder, ctx, state)) return;
		if (project === "work" && !fetching) {
			fetching = true;
			try {
				const result = await pi.exec("python3", [join(homedir(), ".local/bin/agent-run"), "--fetch-replies"], { timeout: 20000 });
				if (result.code !== 0) ctx.ui.notify("Work reply fetch failed, check the restricted aether inbox key", "warning");
			} catch {
				ctx.ui.notify("Work reply fetch failed, replies remain on aether", "warning");
			} finally {
				fetching = false;
			}
		}
		await offerOpen(pi, project, folder, ctx, state);
	};

	pi.on("session_start", (_event, ctx) => {
		state.offered.clear();
		state.busy = false;
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
		description: "List open cross-project requests and offer them again",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("The inbox needs the interactive Rex tab", "error");
				return;
			}
			await ctx.waitForIdle();
			if (project === "work") await poll(ctx);
			const open = openItems(folder, project);
			ctx.ui.notify(open.length
				? `Open requests: ${open.map((item) => `${item.id} from ${item.from}`).join(", ")}`
				: "No open requests", "info");
			for (const item of open) state.offered.delete(item.id);
			await offerOpen(pi, project, folder, ctx, state);
		},
	});
}