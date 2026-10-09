// Mandatory worker handshake. The parent never sends a task until policy and tools are ready.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { validateWorkspace, workspacePath, type Workspace } from "./worktree.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import profile from "../profile/index.ts";
import { killWorkerGroup, startParentWatch, validateTools } from "./worker-policy.ts";

export default function bootstrap(pi: ExtensionAPI) {
	if (process.env.PI_WORKER !== "1") throw new Error("Worker bootstrap requires PI_WORKER=1");
	const policy = profile(pi);
	const tools = validateTools(JSON.parse(process.env.PI_WORKER_TOOLS ?? "[]"));
	const allowed = new Set(tools);
	const files = new Set<string>(JSON.parse(process.env.PI_WORKER_FILES ?? "[]"));
	const workspace: Workspace | undefined = process.env.PI_WORKER_WORKSPACE ? JSON.parse(process.env.PI_WORKER_WORKSPACE) : undefined;
	if (workspace) {
		if (tools.includes("bash") || validateWorkspace(workspace, workspace.parentCwd) !== process.cwd()) throw new Error("Invalid isolated worker capability/cwd boundary");
		if (JSON.stringify([...files].sort()) !== JSON.stringify(workspace.files.map(p => resolve(workspace.root, p)).sort())) throw new Error("Isolated worker ownership mismatch");
	}
	const prompt = readFileSync(process.env.PI_WORKER_PROMPT_FILE!, "utf8");
	pi.on("tool_call", (event, ctx) => {
		if (!allowed.has(event.toolName)) return { block: true, reason: "Tool is outside this worker's assignment" };
		if (["edit", "write"].includes(event.toolName)) {
			const input = event.input as { path?: string; file_path?: string };
			const path = input.path ?? input.file_path;
			if (!path || !files.has(resolve(ctx.cwd, path))) return { block: true, reason: "File is outside this worker's explicit ownership" };
			if (workspace) workspacePath(workspace.root, relative(workspace.root, resolve(ctx.cwd, path)));
		}
		if (event.toolName === "fetch_content") {
			const input = event.input as { url?: string; urls?: string[] };
			if ([...(input.url ? [input.url] : []), ...(input.urls ?? [])].some((url) => !/^https?:\/\//i.test(url)))
				return { block: true, reason: "Web workers may fetch HTTP(S) URLs, not local files" };
		}
		return undefined;
	});
	pi.on("before_agent_start", () => ({ systemPrompt: prompt }));
	let stopWatch: (() => void) | undefined;
	pi.on("session_start", () => { stopWatch = startParentWatch(Number(process.env.PI_WORKER_PARENT_PID)); });
	pi.on("session_shutdown", () => {
		stopWatch?.();
		// RPC stdin EOF can dispose this worker before the orphan poll fires. Always
		// clean the owned group at disposal as well. The parent already received
		// agent_settled before requesting normal EOF, and preserves that result.
		killWorkerGroup();
	});
	let accepting = false;
	pi.on("agent_start", () => { accepting = true; });
	pi.on("agent_settled", () => { accepting = false; });
	pi.registerCommand("worker-steer", {
		description: "Internal parent steering; correlated queue-only acknowledgement",
		handler: async (args, ctx) => {
			const [id, encoded] = args.split(" ");
			if (!/^steer-\d+$/.test(id) || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 11000) throw new Error("Invalid steering payload");
			const text = Buffer.from(encoded, "base64").toString("utf8");
			if (!text.trim() || Buffer.byteLength(text) > 8192) throw new Error("Invalid steering size");
			const accepted = accepting && !ctx.isIdle();
			// sendCustomMessage's active queue branch is synchronous and never prompts when
			// idle without triggerTurn. Do NOT use sendUserMessage: its input hooks await,
			// so it can cross settlement and accidentally start a new model run.
			if (accepted) pi.sendMessage({ customType: "pi-worker-steering", content: text, display: true }, { deliverAs: "steer" });
			pi.sendMessage({ customType: "pi-worker-steer-ack", content: "", display: false,
				details: { id, accepted, error: accepted ? undefined : "Worker already settled; resume explicitly" } }, { triggerTurn: false });
		},
	});
	pi.registerCommand("worker-ready", {
		description: "Internal parent/worker policy handshake",
		handler: async (_args, ctx) => {
			const why = policy.workerBlock(ctx.model);
			if (why) throw new Error(why);
			const available = new Set(pi.getAllTools().map((t) => t.name));
			for (const tool of tools) if (!available.has(tool)) throw new Error(`Worker tool unavailable: ${tool}`);
			if (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("Worker model has no configured credentials");
			pi.setActiveTools(tools);
			pi.sendMessage({ customType: "pi-worker-ready", content: "Worker policy and tools verified.", display: false,
				details: { model: `${ctx.model.provider}/${ctx.model.id}`, tools, sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd, workspace: workspace?.root } }, { triggerTurn: false });
		},
	});
}
