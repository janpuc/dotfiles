// One bounded CLI/RPC runner shared by workers and advisors. No task is sent before policy readiness.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { boundedText, WORKER_CONSTRAINTS, workerEnvironment, WEB_TOOLS } from "./worker-policy.ts";
import { validateWorkspace, type Workspace } from "./worktree.ts";
import type { CheckoutDelegation } from "./checkout.ts";

const MAX_RECORD = 4 * 1024 * 1024;
const MAX_OUTPUT = 48 * 1024;
const STARTUP_MS = 60_000;
export interface WorkerRequest {
	cwd: string; model: string; thinking: string; tools: string[]; task: string; systemPrompt: string; files?: string[];
	timeoutMs?: number; signal?: AbortSignal; sessionFile?: string; isolated?: boolean; workspace?: Workspace; checkoutDelegation?: CheckoutDelegation;
	onSpawn?: (pid: number) => void; onEvent?: (event: any) => void;
	onControl?: (control: WorkerControl) => void;
}
export interface WorkerControl { steer(text: string): Promise<void> }
export interface WorkerResult {
	state: "succeeded" | "failed" | "cancelled" | "timed_out";
	output: string; error?: string; model: string; tools: string[]; turns: number;
}

// A project's Claude Code settings could switch a Claude worker from the subscription to API billing.
export function validateClaudeProject(cwd: string) {
	const root = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim();
	for (const dir of new Set([cwd, ...(root ? [root] : [])])) {
		for (const name of ["settings.json", "settings.local.json"]) {
			const file = join(dir, ".claude", name);
			if (!existsSync(file)) continue;
			const settings = JSON.parse(readFileSync(file, "utf8"));
			if (settings.apiKeyHelper || Object.keys(settings.env ?? {}).some((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(k)))
				throw new Error(`Worker refused project Claude billing override in ${file}`);
		}
	}
}

function installedExtensions(agentDir: string, request: WorkerRequest): string[] {
	const extensions: string[] = [];
	if (request.model.startsWith("claude-bridge/")) {
		const fork = join(agentDir, "git", "github.com", "janpuc", "pi-claude-bridge", "src", "index.ts");
		const npm = join(agentDir, "npm", "node_modules", "pi-claude-bridge", "src", "index.ts");
		const entry = existsSync(fork) ? fork : npm;
		if (!existsSync(entry)) throw new Error("Claude bridge is not installed for this worker profile");
		extensions.push(entry);
	}
	if (request.tools.some((t) => WEB_TOOLS.includes(t))) {
		const entry = join(agentDir, "npm", "node_modules", "pi-web-access", "dist", "index.js");
		if (!existsSync(entry)) throw new Error("Web provider is not installed for this worker profile");
		extensions.push(entry);
	}
	extensions.push(join(process.env.HOME!, ".pi", "shared", "extensions", "subagent", "bootstrap.ts"));
	return extensions;
}

export async function runWorker(request: WorkerRequest): Promise<WorkerResult> {
	// A managed same-repository descriptor is the only cross-cwd exception.
	if (request.workspace) {
		if (request.tools.includes("bash") || realpathSync(request.workspace.parentCwd) !== realpathSync(process.cwd()) || validateWorkspace(request.workspace, process.cwd()) !== realpathSync(request.cwd))
			throw new Error("Worker worktree boundary/unsafe shell loadout mismatch");
	} else if (request.isolated || realpathSync(request.cwd) !== realpathSync(process.cwd()))
		throw new Error("Workers currently run in the parent's working directory; start the appropriate main profile for another project");
	if (!/^[\w-]+\/[^\s:]+$/.test(request.model) || /^(personal|work|router)\//.test(request.model))
		throw new Error("Workers require a fixed native provider/model, not a virtual route or fuzzy model name");
	if (request.model.startsWith("claude-bridge/")) { validateClaudeProject(request.cwd); if (request.workspace) validateClaudeProject(request.workspace.parentCwd); }
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, ".pi", "agent");
	const extensions = installedExtensions(agentDir, request);
	const prompt = `${WORKER_CONSTRAINTS}\n\n${request.systemPrompt}`;
	const dir = await mkdtemp(join(tmpdir(), "pi-worker-"));
	try {
		const promptFile = join(dir, "system.md");
		await writeFile(promptFile, prompt, { mode: 0o600 });
		const env = workerEnvironment(process.env, request.tools, promptFile, request.files);
		if (request.workspace) env.PI_WORKER_WORKSPACE = JSON.stringify(request.workspace);
		if (request.checkoutDelegation) env.PI_WORKER_CHECKOUT = JSON.stringify(request.checkoutDelegation);
		const args = ["--mode", "rpc", ...(request.sessionFile ? ["--session", request.sessionFile, "--session-dir", dirname(request.sessionFile)] : ["--no-session"]), "--no-extensions", "--no-skills", "--no-prompt-templates",
			"--no-context-files", "--no-mcp", "--no-approve", ...(request.tools.length ? ["--tools", request.tools.join(",")] : ["--no-tools"]), "--system-prompt", promptFile,
			"--model", request.model, "--models", request.model, "--thinking", request.thinking,
			...extensions.flatMap((entry) => ["-e", entry])];
		const script = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
		if (!script || !/\/(cli|pi)\.(js|ts)$/.test(script))
			throw new Error("Cannot identify the running Pi CLI; refusing an unsafe launcher fallback");
		return await collectWorker(process.execPath, [script, ...args], env, request);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Exported transport permits offline process/protocol tests without credentials or Pi discovery.
export function collectWorker(command: string, args: string[], env: NodeJS.ProcessEnv, request: WorkerRequest): Promise<WorkerResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: request.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
		let finished = false, exited = false, stopping = false, ready = false, settled = false, failure = "", assistantError = "", output = "", stderr = "", buffer = "", turns = 0;
		let state: WorkerResult["state"] = "failed";
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let teardown: ReturnType<typeof setTimeout> | undefined;
		let closeDeadline: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
		let forcedTeardown = false, idle = false, steeringSequence = 0;
		const steering = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
		const send = (message: object) => { if (!exited && !stopping && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify(message)}\n`); };
		const signalTree = (signal: NodeJS.Signals) => {
			try { if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal); else proc.kill(signal); } catch { /* already exited */ }
		};
		const stop = (next: WorkerResult["state"], error: string) => {
			if (finished || stopping) return;
			stopping = true;
			if (settled) forcedTeardown = true;
			else { state = next; failure ||= error; }
			signalTree("SIGTERM");
			escalation ??= setTimeout(() => {
				signalTree("SIGKILL");
				// No synthetic "exit": keep ownership/admission until Node observes exit.
				// A process stuck in uninterruptible I/O must not be resumed concurrently.
			}, 1500);
		};
		const abort = () => stop("cancelled", "Worker cancelled; discard any partial output");
		const startup = setTimeout(() => stop("failed", "Worker policy readiness handshake timed out"), STARTUP_MS);
		const timeout = setTimeout(() => stop("timed_out", "Worker exceeded its time limit"), request.timeoutMs ?? 15 * 60_000);
		const decoder = new StringDecoder("utf8");
		// Child-local command atomically refuses idle steering. Unlike RPC prompt(steer),
		// it cannot accidentally start another run after settlement. Drain ACKs before EOF.
		try { request.onControl?.({ steer: (text) => {
			if (!ready || stopping || settled || idle) return Promise.reject(new Error("Worker is settling or not ready; resume after it finishes"));
			if (!text.trim() || Buffer.byteLength(text) > 8192 || steering.size >= 4) return Promise.reject(new Error("Steering needs 1–8192 bytes; at most four messages may await acknowledgement"));
			return new Promise<void>((resolve, reject) => {
				const id = `steer-${++steeringSequence}`; steering.set(id, { resolve, reject });
				send({ id, type: "prompt", message: `/worker-steer ${id} ${Buffer.from(text).toString("base64")}` });
			});
		} }); } catch (error) { stop("failed", `Worker control setup failed: ${error}`); }
		const settle = () => {
			if (!idle || steering.size || settled || stopping) return;
			settled = true; clearTimeout(timeout);
			failure ||= assistantError;
			state = !failure && output.trim() ? "succeeded" : "failed";
			proc.stdin.end();
			teardown = setTimeout(() => stop(state, "Worker shutdown exceeded its grace period"), 3000);
		};
		const processLine = (line: string) => {
			if (stopping) return;
			let event: any;
			try { event = JSON.parse(line); } catch { return; }
			try { request.onEvent?.(event); } catch (error) { return stop("failed", `Worker progress/persistence failed: ${error}`); }
			const ack = event.type === "message_end" && event.message?.customType === "pi-worker-steer-ack" ? event.message.details : undefined;
			if (ack && steering.has(ack.id)) {
				const pending = steering.get(ack.id)!; steering.delete(ack.id);
				if (ack.accepted === true) pending.resolve(); else pending.reject(new Error(ack.error ?? "Steering rejected; resume explicitly"));
				settle(); return;
			}
			// Command dispatch is not acceptance: Pi reports a handled command even if its
			// handler threw. Only the correlated child acknowledgement above completes steer.
			if (event.type === "response" && steering.has(event.id) && event.success) return;
			if (event.type === "extension_error") return stop("failed", `Worker extension failed: ${event.error}`);
			if (event.type === "response" && event.command === "get_commands") {
				if (!event.success || !event.data?.commands?.some((c: any) => c.name === "worker-ready"))
					return stop("failed", "Mandatory worker bootstrap did not load; no task was sent");
				send({ id: "ready", type: "prompt", message: "/worker-ready" });
			}
			if (event.type === "response" && event.success === false) return stop("failed", String(event.error ?? "Worker RPC request failed"));
			const message = event.type === "message_end" ? event.message : undefined;
			if (message?.customType === "pi-worker-ready" && !ready) {
				if (message.details?.model !== request.model || JSON.stringify(message.details?.tools) !== JSON.stringify(request.tools) || (request.sessionFile && message.details?.sessionFile !== request.sessionFile) || (request.workspace && (message.details?.cwd !== request.cwd || message.details?.workspace !== request.workspace.root)))
					return stop("failed", "Worker readiness does not match requested model/tools");
				ready = true;
				clearTimeout(startup);
				send({ id: "task", type: "prompt", message: request.task });
			}
			if (message?.role === "assistant" && ready) {
				turns++;
				const text = (message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
				output = boundedText(text, MAX_OUTPUT);
				assistantError = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage ?? `Worker ${message.stopReason}` : "";
				if (turns >= 40 && message.stopReason !== "stop") stop("failed", "Worker reached its 40-assistant-turn limit");
			}
			if (event.type === "agent_settled" && ready && !settled) {
				idle = true; if (event.aborted) failure ||= "Worker run aborted";
				settle();
			}
		};
		proc.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				if (line.length > MAX_RECORD) { stop("failed", "Worker protocol record exceeded limit"); continue; }
				processLine(line);
			}
			if (buffer.length > MAX_RECORD) { buffer = ""; stop("failed", "Worker protocol record exceeded limit"); }
		});
		proc.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
		proc.stdin.on("error", () => { /* close/exit handler owns the result */ });
		proc.on("error", (error) => { failure = error.message; });
		const finish = (code: number | null, signal?: NodeJS.Signals | null) => {
			if (finished) return;
			finished = true; exited = true;
			if (buffer.trim()) processLine(buffer + decoder.end());
			clearTimeout(startup); clearTimeout(timeout);
			for (const timer of [escalation, teardown, closeDeadline]) if (timer) clearTimeout(timer);
			request.signal?.removeEventListener("abort", abort);
			for (const pending of steering.values()) pending.reject(new Error("Worker stopped before acknowledging steering"));
			steering.clear();
			// Do not let a descendant holding a pipe descriptor make cancellation await forever.
			signalTree("SIGKILL");
			proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
			// Mandatory bootstrap kills its whole group on RPC disposal, including normal
			// stdin EOF after settlement. Task success is authoritative at that point.
			const disposalKill = code === null && signal === "SIGKILL" && settled;
			if (state === "succeeded" && ((code !== 0 && !forcedTeardown && !disposalKill) || !settled)) state = "failed";
			resolve({ state, output, ...(state === "succeeded" ? {} : { error: boundedText(failure ? `${failure}${stderr.trim() ? `\n${stderr.trim()}` : ""}` : stderr.trim() || `Worker exited ${code} before completing`, MAX_OUTPUT) }),
				model: request.model, tools: request.tools, turns });
		};
		proc.on("exit", (code, signal) => {
			exited = true; exitCode = code; exitSignal = signal;
			signalTree("SIGKILL");
			closeDeadline ??= setTimeout(() => finish(code, signal), 1500);
		});
		proc.on("close", finish);
		request.signal?.addEventListener("abort", abort, { once: true });
		try { if (proc.pid) request.onSpawn?.(proc.pid); } catch (error) { stop("failed", `Cannot persist worker ownership: ${error}`); }
		if (request.signal?.aborted) abort(); else send({ id: "commands", type: "get_commands" });
	});
}
