// Read-only second opinions use the same minimal, policy-verified runner as other workers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runWorker } from "../subagent/runner.ts";
import { registerPoolLifecycle, workerPool, type WorkerPool, type WorkerRunner } from "../subagent/pool.ts";
import { READ_TOOLS } from "../subagent/worker-policy.ts";
import type { Pressure } from "./usage.ts";

export const ADVISORS = {
	astra: { provider: "openai", model: "gpt-6-astra", thinking: "high" },
	fable: { provider: "claude-bridge", model: "claude-fable-5-1", thinking: "xhigh" },
} as const;
type Target = typeof ADVISORS[keyof typeof ADVISORS];

const ADVISOR_PROMPT = "You are an independent senior engineering advisor. Answer the parent's self-contained question using read-only source inspection. Recommend an approach, explain the key risks and alternatives, and cite concrete files/lines. Do not edit or execute commands. Be concise; the parent owns the decisions.";

export function registerAdvisor(pi: ExtensionAPI, opts: {
	blocked: () => string | undefined;
	pressureOf?: (target: Target) => Pressure | undefined;
}, pool: WorkerPool = workerPool, run: WorkerRunner = runWorker) {
	registerPoolLifecycle(pi, pool);
	const names = Object.keys(ADVISORS) as (keyof typeof ADVISORS)[];
	pi.registerTool({
		name: "advisor", label: "Advisor", exposure: "model-only", executionMode: "sequential",
		description: `Ask a read-only advisor (${names.join(", ")}) for an independent second opinion. Supply the question, constraints, findings and relevant file paths; it has no conversation or memory.`,
		promptSnippet: `advisor: second opinion from ${names.join("/")} (read-only)`,
		promptGuidelines: [
			`When the user asks you to ask, check with or consult ${names.join(", ")} or the advisor, call this tool with that advisor.`,
			"Consult autonomously only for genuinely hard or high-stakes work: architecture, a subtle bug after two failed fixes, or a risky migration/data change. Not routine work.",
			"Weigh the advice, then briefly state what you took from it and decided.",
		],
		parameters: Type.Object({ question: Type.String(), context: Type.Optional(Type.String()), advisor: Type.Optional(Type.String()) }),
		async execute(_id, params, signal, onUpdate, ctx) {
			const why = opts.blocked(); if (why) throw new Error(why);
			const asked = params.advisor?.trim().toLowerCase();
			if (asked && !names.includes(asked as keyof typeof ADVISORS)) throw new Error(`Advisor ${asked} is unavailable here. Available: ${names.join(", ")}.`);
			const usable = (name: keyof typeof ADVISORS) => {
				const target = ADVISORS[name];
				const model = target && ctx.modelRegistry.find(target.provider, target.model);
				return target && model && ctx.modelRegistry.hasConfiguredAuth(model) && !opts.pressureOf?.(target)?.exhausted;
			};
			const name = (asked as keyof typeof ADVISORS | undefined) ?? names.find(usable);
			if (!name || !usable(name)) throw new Error("Requested advisor has no credentials or its subscription is exhausted; explicitly choose another available advisor.");
			const target = ADVISORS[name];
			const label = `${name} (${target.provider}/${target.model}, ${target.thinking})`;
			onUpdate?.({ content: [{ type: "text", text: `Consulting ${label}…` }], details: { advisor: name } });
			const result = await pool.run({ cwd: ctx.cwd, model: `${target.provider}/${target.model}`, thinking: target.thinking,
				tools: READ_TOOLS, signal, systemPrompt: ADVISOR_PROMPT,
				task: `Question:\n${params.question}${params.context ? `\n\nContext:\n${params.context}` : ""}` }, run);
			if (result.state !== "succeeded") throw new Error(`${label}: ${result.error ?? result.state}`);
			return { content: [{ type: "text", text: `Advice from ${label}:\n\n${result.output}` }], details: { advisor: name, ...result } };
		},
	});
}
