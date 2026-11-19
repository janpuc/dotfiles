// Task close and restart are idle-boundary requests, never terminal keystrokes.
import { existsSync, readFileSync } from "node:fs";
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
	const poll = (ctx: ExtensionContext) => {
		if (promptOpen || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (existsSync(join(state, "closed")) || existsSync(join(state, "restart-requested"))) {
			ctx.shutdown();
		} else if (!closing && existsSync(join(state, "close-requested"))) {
			const request = readFileSync(join(state, "close-requested"), "utf8");
			if (request === offered) return;
			offered = request;
			closing = true;
			pi.sendUserMessage(`Close task ${task} now. Update STATE.md and write ${join(folder, "RESULT.md")} with a title including the ticket when attached and these level-two headings: Outcome, Changes, Verification, Learned, Open. Record only verified outcomes and preserve pending approvals. Save durable facts to the project memini namespace with ticket:<ID> or task:<slug> tags and metadata. Do not edit project PROJECT.md or STATE.md. When the result is complete, finish with TASK_CLOSE_READY on its own line. If blocked or a step fails, explain it and do not emit that marker.`);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		closing = false;
		offered = "";
		if (timer) clearInterval(timer);
		timer = setInterval(() => poll(ctx), 5000);
		timer.unref();
	});
	pi.on("session_shutdown", () => { if (timer) clearInterval(timer); });
	pi.on("ui_prompt_start", () => { promptOpen = true; });
	pi.on("ui_prompt_end", () => { promptOpen = false; });
	pi.on("agent_settled", async (event, ctx) => {
		if (!closing) { poll(ctx); return; }
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
