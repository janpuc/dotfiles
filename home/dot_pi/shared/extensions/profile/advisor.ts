// The `advisor` tool: a second opinion from a stronger model that is not in the model list
// (personal: astra = GPT-6 Astra, fable = Claude Fable 5.1; Work: fable on the enterprise seat).
// The agent calls it when asked ("ask fable", "check with astra") or when a task is genuinely
// hard. Each consultation is a separate `pi` process with read-only tools, in the same profile,
// so the Work policy, memory scope and request guard apply inside it too, and the Claude bridge
// is never re-entered from inside a running turn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { providerAllowed, type Profile, type RoutingConfig, type Target, type TargetPressure } from "./policy.ts";

const TIMEOUT_MS = 15 * 60_000;

const ADVISOR_PROMPT = `You are the advisor: a senior engineer another coding agent consults for a second opinion about work in this repository. You have read-only tools (read, grep, find, ls) and cannot edit files or run commands. Check the code you need, then answer the question directly: your recommendation, the reasoning, the main risks or alternatives, and concrete next steps, citing files and lines where useful. Be concise; the other agent will act on your answer.`;

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** The same Pi CLI that is running, as the subagent example resolves it. */
function piInvocation(args: string[]): [string, string[]] {
	const script = process.argv[1];
	return script && existsSync(script) ? [process.execPath, [script, ...args]] : ["pi", args];
}

export function registerAdvisor(
	pi: ExtensionAPI,
	opts: {
		cfg: RoutingConfig | undefined;
		models: Profile;
		profile: Profile;
		blocked: () => string | undefined;
		/** Subscription usage of a target; an exhausted advisor is refused, a busy one skipped by default. */
		pressureOf?: (t: Target) => TargetPressure | undefined;
	},
) {
	const spec = opts.cfg?.advisors?.[opts.models];
	if (!spec) return;
	const names = Object.keys(spec.models);
	const elsewhere = Object.entries(opts.cfg?.advisors ?? {})
		.filter(([p]) => p !== opts.models)
		.flatMap(([, s]) => Object.keys(s?.models ?? {}))
		.filter((n) => !names.includes(n));

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description:
			`Ask a stronger advisor model for a second opinion (${names.join(", ")}). It runs separately with read-only access to this repository and answers with advice only. ` +
			"Give it a self-contained question plus the context and file paths that matter; it has not seen this conversation.",
		promptSnippet: `advisor: second opinion from ${names.join("/")} (read-only)`,
		promptGuidelines: [
			`When the user asks you to ask, check with or consult ${names.join(", ")} or "the advisor", call the advisor tool${names.length > 1 ? " with that advisor" : ""}.`,
			"Consult the advisor on your own only when a task is genuinely hard or high-stakes: an architecture decision, a subtle bug you have failed to fix twice, a risky migration or data change. Not for routine work.",
			"Weigh the advice, then say briefly what you took from it and what you decided.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question, self-contained." }),
			context: Type.Optional(Type.String({ description: "What you know so far: relevant findings, constraints, file paths, what you already tried." })),
			advisor: Type.Optional(Type.String({ description: `${names.join(" or ")}; omit for the default (${spec.order.join(", then ")}).` })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const why = opts.blocked();
			if (why) throw new Error(why);
			const asked = params.advisor?.trim().toLowerCase();
			if (asked && !names.includes(asked)) {
				if (elsewhere.includes(asked) && opts.profile === "work")
					throw new Error(`${asked} is a personal model and is not available in Work sessions. Use ${names.join(" or ")}, or restart deliberately on personal models: piw --personal-models -c`);
				throw new Error(`Unknown advisor "${asked}". Available here: ${names.join(", ")}.`);
			}
			const usable = (name: string): Target | undefined => {
				const t = spec.models[name];
				const m = t && ctx.modelRegistry.find(t.provider, t.model);
				return t && opts.cfg && providerAllowed(opts.cfg, opts.models, t.provider) && m && ctx.modelRegistry.hasConfiguredAuth(m) ? t : undefined;
			};
			const pressure = (n: string) => (spec.models[n] ? opts.pressureOf?.(spec.models[n]) : undefined);
			if (asked && pressure(asked)?.exhausted) {
				const others = names.filter((n) => n !== asked && usable(n) && !pressure(n)?.exhausted);
				throw new Error(`${asked}'s subscription is used up (${pressure(asked)!.worst}).${others.length ? ` Ask ${others.join(" or ")} instead.` : ""}`);
			}
			// Unnamed: the first advisor with headroom, else the least-used one that is not exhausted.
			const candidates = spec.order.filter((n) => usable(n) && !pressure(n)?.exhausted);
			const name = asked ?? candidates.find((n) => (pressure(n)?.usedPct ?? 0) < 90) ?? candidates.sort((a, b) => (pressure(a)?.usedPct ?? 0) - (pressure(b)?.usedPct ?? 0))[0];
			const target = name ? usable(name) : undefined;
			if (!name || !target)
				throw new Error(
					asked
						? `${asked} has no credentials in this profile${spec.models[asked].provider === "openai-codex" ? " (log in once with /login openai-codex)" : ""}.`
						: `No advisor has credentials in this profile (${names.join(", ")}).`,
				);

			const dir = await mkdtemp(join(tmpdir(), "pi-advisor-"));
			const promptFile = join(dir, "advisor.md");
			await writeFile(promptFile, ADVISOR_PROMPT, { mode: 0o600 });
			const task = `Question from the coding agent:\n${params.question}${params.context ? `\n\nContext it provided:\n${params.context}` : ""}`;
			const [cmd, args] = piInvocation([
				"--mode", "json", "-p", "--no-session",
				"--model", `${target.provider}/${target.model}`,
				"--thinking", target.thinking,
				"--tools", "read,grep,find,ls",
				"--append-system-prompt", promptFile,
				task,
			]);
			const label = `${name} (${target.provider}/${target.model}, ${target.thinking})`;
			onUpdate?.({ content: [{ type: "text", text: `Consulting ${label}…` }], details: { advisor: name } });

			const usage = zero();
			let answer = "";
			let error = "";
			let turns = 0;
			let stderr = "";
			try {
				const code = await new Promise<number>((resolve, reject) => {
					const proc = spawn(cmd, args, {
						cwd: ctx.cwd,
						stdio: ["ignore", "pipe", "pipe"],
						// The calling session captures the outcome; the consultation itself is not saved to memory.
						env: { ...process.env, MEMINI_CAPTURE: "0", MEMINI_CAPTURE_TURNS: "0", MEMINI_SESSION_DIGEST: "0", MEMINI_AUTO_SAVE: "0" },
					});
					const kill = () => proc.kill("SIGTERM");
					const timer = setTimeout(kill, TIMEOUT_MS);
					signal?.addEventListener("abort", kill, { once: true });
					let buffer = "";
					proc.stdout.on("data", (chunk) => {
						buffer += chunk;
						let nl: number;
						while ((nl = buffer.indexOf("\n")) >= 0) {
							const line = buffer.slice(0, nl);
							buffer = buffer.slice(nl + 1);
							let ev: any;
							try {
								ev = JSON.parse(line);
							} catch {
								continue;
							}
							const m = ev?.type === "message_end" ? ev.message : undefined;
							if (m?.role !== "assistant") continue;
							turns++;
							const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
							if (text) answer = text;
							if (m.stopReason === "error") error = m.errorMessage ?? "advisor request failed";
							const u = m.usage;
							if (u) {
								for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[k] += u[k] ?? 0;
								for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[k] += u.cost?.[k] ?? 0;
							}
						}
					});
					proc.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
					proc.on("error", reject);
					proc.on("close", (c) => {
						clearTimeout(timer);
						resolve(c ?? 1);
					});
				});
				if (signal?.aborted) throw new Error("advisor consultation cancelled");
				if (!answer) throw new Error(`${label} gave no answer${error ? `: ${error}` : code ? ` (exit ${code}): ${stderr.trim().split("\n").pop()}` : ""}`);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
			return {
				content: [{ type: "text", text: `Advice from ${label}:\n\n${answer}` }],
				details: { advisor: name, provider: target.provider, model: target.model, thinking: target.thinking, turns },
				usage: usage as any,
			};
		},
	});
}
