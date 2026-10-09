// The BC250 board behind litellm/bc250* is loud. Subagents may use it from 23:00 to 07:00
// local time, or when the current user message asks for it by name. pi-subagents' model
// scope cannot express hours, so this blocks the subagent call instead.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BC250 = /bc250/i;
const ASKED = /\b(bc250|qwen|local model)\b/i;
const quietHours = (hour: number) => hour >= 23 || hour < 7;

// Model ids anywhere in a call: top level, tasks[] and chain steps. Task text may name the
// board without running on it.
function models(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(models);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, v]) => (key === "model" && typeof v === "string" ? [v] : models(v)));
}

export default function (pi: ExtensionAPI) {
	let prompt = "";
	pi.on("before_agent_start", (event) => {
		prompt = event.prompt;
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent" || !models(event.input).some((model) => BC250.test(model))) return;
		if (quietHours(new Date().getHours()) || ASKED.test(prompt)) return;
		return {
			block: true,
			reason: "BC250 is loud: outside 23:00-07:00 it runs only when Jan's message asks for it. Pick another model.",
		};
	});
}
