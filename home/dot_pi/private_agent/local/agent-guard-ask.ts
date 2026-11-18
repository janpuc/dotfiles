// Jan approves shared changes in the Rex tab. Children keep the unconditional guard instead.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sharedChange } from "./agent-guard.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") return;
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const what = sharedChange(command);
		if (!what) return;
		if (ctx.mode === "tui" && ctx.hasUI && await ctx.ui.confirm(`Allow ${what}?`, command)) return;
		return { block: true, reason: `Blocked ${what}: Jan's approval in the interactive Rex tab is required.` };
	});
}
