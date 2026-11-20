// Task close and restart are idle-boundary requests, never terminal keystrokes.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
		if (promptOpen || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.mode !== "tui" || !ctx.hasUI) return;
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
			pi.sendUserMessage(`Close task ${task} now. Update STATE.md and write ${join(folder, "RESULT.md")} with a title including the ticket when attached and these level-two headings: Outcome, Changes, Verification, Learned, Open. Record only verified outcomes and preserve pending approvals. Save durable facts to the project memini namespace with ticket:<ID> or task:<slug> tags and metadata. Do not edit project PROJECT.md or STATE.md. When the result is complete, finish with TASK_CLOSE_READY on its own line. If blocked or a step fails, explain it and do not emit that marker.`);
		}
	};
	// agent task send queues messages from the coordinator. Each moves to delivered/ before it is
	// sent, so a crash never sends it twice.
	const deliver = (): boolean => {
		const inbox = join(state, "messages");
		if (!existsSync(inbox)) return false;
		const next = readdirSync(inbox).filter((name) => name.endsWith(".md")).sort()[0];
		if (!next) return false;
		mkdirSync(join(inbox, "delivered"), { recursive: true });
		const delivered = join(inbox, "delivered", next);
		renameSync(join(inbox, next), delivered);
		pi.sendUserMessage(`Message for task ${task} from the ${project} coordinator, sent with agent task send:\n\n${readFileSync(delivered, "utf8").trim()}`);
		return true;
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
			if (ctx.isIdle() && !ctx.hasPendingMessages() && !existsSync(join(state, "close-requested"))) waiting(true);
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
		}
	});
}
