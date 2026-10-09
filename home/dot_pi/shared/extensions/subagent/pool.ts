// One admission/lifetime registry for every child in the active parent session, including advisors.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerRequest, WorkerResult } from "./runner.ts";
export type WorkerRunner = (request: WorkerRequest) => Promise<WorkerResult>;

export class WorkerPool {
	private live = false;
	private epoch = 0;
	private checkout: symbol | undefined;
	private readonly running = new Set<{ controller: AbortController; request: WorkerRequest; done: Promise<WorkerResult> }>();
	get generation() { return this.epoch; }
	get count() { return this.running.size; }
	get hasWriter() { return !!this.checkout || [...this.running].some(({ request }) => !request.isolated && request.tools.some((t) => ["bash", "edit", "write"].includes(t))); }
	reserveCheckout() {
		if (!this.live || this.hasWriter) throw new Error("Parent checkout is already owned or inactive");
		const token = this.checkout = Symbol();
		return { valid: () => this.live && this.checkout === token, release: () => { if (this.checkout === token) this.checkout = undefined; } };
	}
	activate() { this.live = true; }
	isCurrent(generation: number) { return this.live && generation === this.epoch; }
	run(request: WorkerRequest, runner: WorkerRunner): Promise<WorkerResult> {
		if (!this.live) throw new Error("Worker runtime is not active");
		if (this.count >= 2) throw new Error("At most 2 workers/advisors may run at once");
		if (this.hasWriter && !request.isolated && request.tools.some((t) => ["bash", "edit", "write"].includes(t)))
			throw new Error("Only one editing worker may own a checkout at a time");
		const controller = new AbortController();
		const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
		const entry = { controller, request, done: undefined! as Promise<WorkerResult> };
		this.running.add(entry); // Reserve synchronously, before any runner can yield.
		entry.done = Promise.resolve().then(() => signal.aborted
			? { state: "cancelled" as const, output: "", error: "Worker cancelled before launch", model: request.model, tools: request.tools, turns: 0 }
			: runner({ ...request, signal })).finally(() => this.running.delete(entry));
		return entry.done;
	}
	async cancelAll() {
		this.live = false; this.epoch++; this.checkout = undefined;
		for (const entry of this.running) entry.controller.abort();
		await Promise.allSettled([...this.running].map((entry) => entry.done));
	}
}

// Pi has one active main session per process. Reload/navigation cancel its complete registry.
// Pi imports each extension with its own module instances (jiti, moduleCache: false), so a plain
// module singleton would give the advisor (profile extension) and workers separate pools.
export const workerPool: WorkerPool = ((globalThis as any)[Symbol.for("pi-subagent.pool")] ??= new WorkerPool());
export function registerPoolLifecycle(pi: ExtensionAPI, pool: WorkerPool) {
	pi.on("session_start", () => pool.activate());
	pi.on("session_shutdown", () => pool.cancelAll());
	const navigate = async () => { await pool.cancelAll(); pool.activate(); };
	pi.on("session_before_switch", navigate);
	pi.on("session_before_fork", navigate);
	pi.on("session_before_tree", navigate);
}
