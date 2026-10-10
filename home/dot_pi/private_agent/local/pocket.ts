// Pi Pocket keeps delegated work alive after this laptop sleeps. See pocket-api.md for the wire API.
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL = "https://aether.tail17d532.ts.net";
const USE = "Use for long/background work that must keep running when the laptop sleeps or this session ends, or that Jan wants to follow from his phone; not quick tasks this session can do itself.";
type Entry = { id: number; kind: string; blocks?: { type: string; text?: string }[]; stopReason?: string; error?: string };
type Approval = { id: string; tool: string; subject: string; reason: string };
type View = { entries: Entry[]; order: number[]; live: { busy: boolean }; approvals: Approval[]; subagents?: { busy: boolean }[] };
type Event = { event: string; data: any };
type Request = (path: string, body?: unknown) => Promise<any>;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
function sessionId(id: string | number): string {
	if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new Error("Bad session id");
	return String(Number(id));
}

async function run(signal: AbortSignal | undefined, action: (request: Request, base: string, clean: (text: string) => string) => Promise<string>) {
	const token = process.env.PI_POCKET_TOKEN?.trim();
	const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });
	if (!token) return result("Pi Pocket not configured: run ai-sync (PI_POCKET_TOKEN is missing).", true);
	const clean = (text: string) => text.split(token).join("[redacted]");
	try {
		const url = new URL(process.env.PI_POCKET_URL || DEFAULT_URL);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("PI_POCKET_URL must be an HTTP(S) URL without credentials, query or fragment");
		const base = url.href.replace(/\/$/, "");
		const timeout = AbortSignal.timeout(15_000);
		const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const request: Request = async (path, body) => {
			const response = await fetch(`${base}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { Authorization: `Bearer ${token}`, "X-Pocket": "1", "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: abort,
				redirect: "error",
			});
			const text = await response.text();
			let data: any;
			try { data = JSON.parse(text); } catch { /* Non-JSON errors stay short. */ }
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${clip(clean(String(data?.error ?? text)).replace(/\s+/g, " "), 240)}`);
			if (data === undefined) throw new Error("Invalid JSON response from Pi Pocket");
			return data;
		};
		return result(clean(await action(request, base, clean)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Pi Pocket: ${clip(clean(message).replace(/\s+/g, " "), 300)}`, true);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pocket_start", label: "Pocket start",
		description: `Delegate a task to the always-on Pi Pocket. ${USE} Results are polled with pocket_check; approvals stay on Jan's phone.`,
		parameters: Type.Object({
			folder: Type.String({ description: "Existing folder on Pocket, e.g. ~/work/home-ops or ~/scratch (not a laptop path)." }),
			task: Type.String({ minLength: 1 }),
			model: Type.Optional(Type.String({ description: "provider/id; defaults to anthropic/claude-sonnet-5-5" })),
			thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)))),
		}),
		async execute(_callId, params, signal) {
			return run(signal, async (request, base) => {
				if (!params.folder.trim() || !params.task.trim()) throw new Error("folder and task must not be empty");
				const model = (params.model ?? "anthropic/claude-sonnet-5-5").trim();
				const slash = model.indexOf("/");
				if (slash < 1 || slash === model.length - 1) throw new Error("model must be provider/id");
				// Pocket expands ~ on its own host; model/thinking require a separate configure call.
				const created = await request("/api/sessions", { cwd: params.folder });
				const id = sessionId(created.id);
				const link = `${base}/s/${id}`;
				try {
					await request(`/api/c/${id}/configure`, { model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }, ...(params.thinking === undefined ? {} : { thinkingLevel: params.thinking }) });
					await request(`/api/c/${id}/submit`, { text: params.task, requestId: randomUUID() });
				} catch (error) {
					throw new Error(`Session ${id} created (${link}), but start did not complete: ${error instanceof Error ? error.message : String(error)}. Check it before retrying.`);
				}
				return `Session ${id}\n${link}\nResults come back through pocket_check; risky commands wait for Jan's approval on his phone (Pocket's guard must be enabled).`;
			});
		},
	});
	pi.registerTool({
		name: "pocket_check", label: "Pocket check",
		description: `Check delegated Pi Pocket work: state, latest assistant answer and pending approvals. ${USE} An idle state is not proof of success; inspect the answer.`,
		parameters: Type.Object({ id: Type.String({ description: "Session id from pocket_start" }) }),
		async execute(_callId, params, signal) {
			return run(signal, async (request, base, clean) => {
				const id = sessionId(params.id);
				// A fresh poll returns hello, sessions and a full view. Close it so checks do not leave tabs behind.
				const poll = await request(`/api/poll?c=${id}`);
				try {
					const events = poll.events as Event[];
					const missing = events.find((event) => event.event === "missing");
					if (missing) throw new Error(missing.data.message);
					const view = events.find((event) => event.event === "view" && event.data.full)?.data as View | undefined;
					if (!view) throw new Error("No conversation view returned");
					const session = events.find((event) => event.event === "sessions")?.data.find((each: { id: number }) => String(each.id) === id);
					let entries = view.order.map((entryId) => view.entries.find((entry) => entry.id === entryId)).filter((entry): entry is Entry => !!entry);
					const textOf = (entry: Entry) => (entry.blocks ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
					if (!entries.some((entry) => entry.kind === "assistant" && textOf(entry).trim())) {
						const history: Entry[] = await request(`/api/c/${id}/history`);
						entries = [...history.filter((past) => !entries.some((entry) => entry.id === past.id)), ...entries];
					}
					const assistants = entries.filter((entry) => entry.kind === "assistant");
					const last = assistants.at(-1);
					const answer = assistants.findLast((entry) => textOf(entry).trim());
					const busy = view.live.busy || view.subagents?.some((agent) => agent.busy);
					const state = view.approvals.length || session?.waiting ? "waiting for approval" : busy ? "working" : last?.error || last?.stopReason === "error" ? "failed" : "idle";
					const approvals = view.approvals.map((approval) => `${approval.id}: ${approval.tool} ${approval.subject} — ${approval.reason}`).join("\n");
					return `Session ${id}: ${state}\n${base}/s/${id}${last?.error ? `\nError: ${clip(clean(last.error), 300)}` : ""}${answer ? `\nLatest assistant answer:\n${clip(clean(textOf(answer)), 4000)}` : "\nNo assistant answer yet."}${approvals ? `\nPending approvals (Jan handles these on his phone):\n${clip(clean(approvals), 2000)}` : session?.waiting ? "\nPending approval in a subagent; open Pocket on the phone for details." : ""}`;
				} finally {
					await request(`/api/poll?session=${encodeURIComponent(poll.session)}&close=1`).catch(() => {});
				}
			});
		},
	});
	pi.registerTool({
		name: "pocket_send", label: "Pocket send",
		description: `Send a follow-up to delegated Pi Pocket work, or steer it after its current tool round if busy. ${USE} This does not approve risky commands.`,
		parameters: Type.Object({ id: Type.String(), message: Type.String({ minLength: 1 }) }),
		async execute(_callId, params, signal) {
			return run(signal, async (request) => {
				const id = sessionId(params.id);
				if (!params.message.trim()) throw new Error("message must not be empty");
				const sent = await request(`/api/c/${id}/submit`, { text: params.message, mode: "steer", requestId: randomUUID() });
				return `Sent to session ${id} (submission ${sent.submissionId}). Use pocket_check for results.`;
			});
		},
	});
}
