// Task close and restart are idle-boundary requests, never terminal keystrokes.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// agent task send queues messages from the coordinator. Each moves to delivered/ before it is
// sent, so a crash never sends it twice. A message gone before the rename was claimed by someone
// else, the agent job drain handing a closing task's result to the project, so it is skipped.
export function take(inbox: string, list: (inbox: string) => string[] = readdirSync): string | undefined {
	if (!existsSync(inbox)) return undefined;
	for (const next of list(inbox).filter((name) => name.endsWith(".md")).sort()) {
		mkdirSync(join(inbox, "delivered"), { recursive: true });
		const delivered = join(inbox, "delivered", next);
		try {
			renameSync(join(inbox, next), delivered);
		} catch (error: any) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		return readFileSync(delivered, "utf8").trim();
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const task = process.env.PI_TASK;
	const project = process.env.PI_PROJECT;
	const state = process.env.PI_TASK_STATE_DIR;
	const folder = process.env.PI_TASK_DIR;
	if (!task || !project || !state || !folder || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") return;
	let closing = false;
	let offered = "";
	let promptOpen = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	// An idle open task waits on Jan. One file per waiting task, which pi-footer counts for its
	// "N waiting" pill. Written when a turn settles, removed when work starts or Pi exits.
	const attention = join(process.env.HOME!, ".local/state/agents/attention", `${project}--${task}.json`);
	const waiting = (on: boolean) => {
		try {
			if (!on) { rmSync(attention, { force: true }); return; }
			if (existsSync(attention)) return;
			mkdirSync(join(attention, ".."), { recursive: true });
			writeFileSync(`${attention}.tmp`, JSON.stringify({ project, task, since: new Date().toISOString(), why: "idle task" }) + "\n");
			renameSync(`${attention}.tmp`, attention);
		} catch { /* the footer pill is a hint, never block the task */ }
	};
	const poll = (ctx: ExtensionContext) => {
		if (promptOpen || ctx.mode !== "tui" || !ctx.hasUI) return;
		// agent task send --steer reaches a busy turn after its current tool call.
		if (!ctx.isIdle() && !closing && !existsSync(join(state, "close-requested"))) { steer(); return; }
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (existsSync(join(state, "closed")) || existsSync(join(state, "restart-requested"))) {
			ctx.shutdown();
		} else if (!closing && !existsSync(join(state, "close-requested"))) {
			// A task restarted after its last turn resumes idle without a settle event, so mark it here.
			if (!deliver() && lastRole(ctx) === "assistant") waiting(true);
		} else if (!closing && existsSync(join(state, "close-requested"))) {
			const request = readFileSync(join(state, "close-requested"), "utf8");
			if (request === offered) return;
			offered = request;
			closing = true;
			const written = existsSync(join(folder, "RESULT.md"));
			pi.sendUserMessage(`Close task ${task} now. The task stays open until this step is done: replying that the work is complete, or a status of closing in BRIEF.md, does not close it. ${written ? `${join(folder, "RESULT.md")} already exists. Check it is accurate and has the headings below, and fix it if not.` : `${join(folder, "RESULT.md")} does not exist yet.`} Do not rewrite deliverables or knowledge pages during close, they may hold the coordinator's review. Update STATE.md and write ${join(folder, "RESULT.md")} with a title including the ticket when attached and these level-two headings: Outcome, Changes, Verification, Learned, Open. Record only verified outcomes and preserve pending approvals. Save durable facts to the project memini namespace with ticket:<ID> or task:<slug> tags and metadata. Do not edit project PROJECT.md or STATE.md. When the result is complete, finish with TASK_CLOSE_READY on its own line. If blocked or a step fails, explain it and do not emit that marker.`);
		}
	};
	// An idle task takes a steering message like any other, steering ones first.
	const deliver = (): boolean => {
		const message = take(join(state, "messages", "steer")) ?? take(join(state, "messages"));
		if (message === undefined) return false;
		pi.sendUserMessage(`Message for task ${task} from the ${project} coordinator, sent with agent task send:\n\n${message}`);
		return true;
	};
	const steer = () => {
		const message = take(join(state, "messages", "steer"));
		if (message === undefined) return;
		pi.sendUserMessage(`Message for task ${task} from the ${project} coordinator, sent with agent task send --steer during your turn. Take it into account before your next step:\n\n${message}`, { deliverAs: "steer" });
	};
	// A turn the coordinator started, with the opening brief or agent task send, reports back to
	// the coordinator through the project inbox, so Jan never relays a task's result by hand.
	// Turns Jan starts in the task tab stay between him and the task.
	const text = (content: unknown) => typeof content === "string" ? content
		: Array.isArray(content) ? content.map((part) => part?.type === "text" ? part.text : "").join("\n") : "";
	// What the session log shows for the turn, so a reply that describes work it never did reads as
	// such. Neon once reported files written after its only tool call failed.
	const record = (ctx: ExtensionContext): string => {
		const branch = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message as any] : []);
		const start = branch.findLastIndex((message) => message.role === "user");
		const turn = branch.slice(start + 1);
		const calls = new Map<string, { name: string; path?: string }>();
		for (const message of turn) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) if (part?.type === "toolCall") calls.set(part.id, { name: part.name, path: part.arguments?.path });
		}
		const results = turn.filter((message) => message.role === "toolResult");
		const failed = results.filter((message) => message.isError).length;
		const written = new Set<string>();
		for (const result of results) {
			const call = calls.get(result.toolCallId);
			if (!result.isError && call?.path && ["write", "edit"].includes(call.name)) written.add(call.path);
			for (const nested of result.nestedCalls?.calls ?? []) {
				if (nested.status === "ok" && ["write", "edit"].includes(nested.name) && nested.arguments?.path) written.add(nested.arguments.path);
			}
		}
		if (results.length === 0) return "Turn record from the session log: no tool calls in this turn.";
		return `Turn record from the session log: ${results.length} tool call${results.length === 1 ? "" : "s"}, ${failed} failed. ${written.size ? `Files written or edited: ${[...written].join(", ")}.` : "No file was written or edited."}`;
	};
	// Sends the last reply to the project inbox once, with a heading when the coordinator must act.
	const post = (ctx: ExtensionContext, heading = ""): boolean => {
		const reply = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry] : []).at(-1);
		if (reply?.message.role !== "assistant" || !process.env.PI_PROJECT_DIR) return false;
		const marker = join(state, "reported");
		if (existsSync(marker) && readFileSync(marker, "utf8").trim() === reply.id) return true;
		try {
			const inbox = join(process.env.PI_PROJECT_DIR, ".agent/inbox");
			const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
			const answer = text(reply.message.content).trim() || "(the turn ended without text)";
			const cut = answer.length > 8000 ? `${answer.slice(0, 8000)}\n\n[cut at 8000 characters, the full reply is in the task session]` : answer;
			const body = `${heading ? `${heading}\n\nThe task's last reply:\n\n${cut}` : cut}\n\n${record(ctx)}`;
			mkdirSync(inbox, { recursive: true });
			writeFileSync(join(inbox, `${id}.json.tmp`), JSON.stringify({ id, from: project, to: project, kind: "report", task, text: body, created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), status: "new" }, null, 2) + "\n", { mode: 0o600 });
			renameSync(join(inbox, `${id}.json.tmp`), join(inbox, `${id}.json`));
			writeFileSync(marker, `${reply.id}\n`);
			return true;
		} catch {
			return false;
		}
	};
	// Only turns the coordinator started report back. Turns Jan starts in the tab stay there.
	const report = (ctx: ExtensionContext): boolean => {
		const asked = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1);
		const prompt = asked?.type === "message" ? text(asked.message.content) : "";
		if (!prompt.startsWith(`Work on task ${task}.`) && !prompt.startsWith(`Message for task ${task} from the ${project} coordinator`)) return false;
		return post(ctx);
	};
	const lastRole = (ctx: ExtensionContext) => {
		const last = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").at(-1);
		return last?.type === "message" ? last.message.role : undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		closing = false;
		offered = "";
		if (timer) clearInterval(timer);
		timer = setInterval(() => poll(ctx), 5000);
		timer.unref();
	});
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); waiting(false); });
	pi.on("agent_start", () => waiting(false));
	pi.on("ui_prompt_start", () => { promptOpen = true; });
	pi.on("ui_prompt_end", () => { promptOpen = false; });
	pi.on("agent_settled", async (event, ctx) => {
		if (!closing) {
			poll(ctx);
			if (ctx.isIdle() && !ctx.hasPendingMessages() && !existsSync(join(state, "close-requested")) && !report(ctx)) waiting(true);
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		closing = false;
		const last = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
		const ready = last?.type === "message" && last.message.role === "assistant"
			&& !["error", "aborted"].includes(last.message.stopReason)
			&& last.message.content.some((part) => part.type === "text" && /(?:^|\n)TASK_CLOSE_READY\s*$/.test(part.text));
		if (event.aborted || !ready) {
			ctx.ui.notify("Task close paused. Resolve the blocker, then run agent task close again or restart the task.", "warning");
			post(ctx, `Close of task ${task} paused: the turn ended without TASK_CLOSE_READY${event.aborted ? " (aborted)" : ""}. Resolve it, then run agent task close ${project} ${task} again. Messages are not delivered while the close is pending.`);
			return;
		}
		try {
			const result = readFileSync(join(folder, "RESULT.md"), "utf8");
			if (["Outcome", "Changes", "Verification", "Learned", "Open"].some((heading) => !new RegExp(`^## ${heading}\\s*$`, "m").test(result))) throw new Error("RESULT.md headings are incomplete");
			const completed = await pi.exec(join(process.env.HOME!, ".local/bin/agent"), ["task", "finalize", project, task]);
			if (completed.code !== 0) throw new Error(completed.stderr || completed.stdout);
			ctx.ui.notify("Task closed. Result and folder retained. The fold request is in the receiving project's inbox.", "info");
			ctx.shutdown();
		} catch (error) {
			ctx.ui.notify(`Task close paused: ${error}. Run agent task close again to retry.`, "error");
			post(ctx, `Close of task ${task} paused: ${error}. Fix it, then run agent task close ${project} ${task} again.`);
		}
	});
}
