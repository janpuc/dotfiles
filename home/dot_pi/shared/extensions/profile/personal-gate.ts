// Personal tool gate (docs/pi-personal-approvals-design.md): routine work runs; consequential effects
// found by effects.ts need an approval Jan granted in this session; secret material stays blocked.
// Approvals live in this instance, never in the environment: they end with the session, and
// workers (separate processes) start with none and report such steps back to the parent.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// typebox is supplied by Pi's extension loader; taking it as a parameter keeps this module testable.
type TypeBuilder = typeof import("typebox").Type;
import { classifyBash, classifyTool, type ClassifyContext, type Effect } from "./effects.ts";

const RETRY_MS = 15 * 60_000;
export type Exec = (args: string[], cwd: string) => string;
const run: Exec = (args, cwd) => {
	const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout: 4000 });
	return r.status === 0 ? r.stdout.trim() : "";
};
// New files have no realpath yet; canonicalize the nearest existing ancestor so a symlinked
// directory cannot hide where a write lands.
const canonical = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		const up = dirname(p);
		return up === p ? p : join(canonical(up), basename(p));
	}
};
// Credentials embedded in remote URLs must reach neither the model nor the dialog.
// Userinfo runs to the last "@" before the host, and may itself contain "@".
const clean = (url: string) => url.replace(/\/\/[^/\s]*@/g, "//");
// Model-authored text is displayed, never interpreted: no control sequences, bounded length.
const plain = (s: unknown, max = 600) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "").slice(0, max);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** Fill in targets only execution reveals. Anything left "unknown" cannot be approved. */
export function resolveEffect(e: Effect, cwd: string, exec: Exec = run): Effect {
	const t = { ...e.target }, dir = t.dir || cwd;
	if (e.op === "git.push") {
		const configs: string[] = t.config ? JSON.parse(t.config)[0] : [];
		const git = ["git", "-C", dir, ...configs.flatMap(c => ["-c", c])];
		const remote = t.remote || exec([...git, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd).split("/")[0] || "origin";
		t.pushUrl = clean(exec([...git, "remote", "get-url", "--push", remote], cwd) || (/[:/]/.test(remote) ? remote : "")) || "unknown";
		// An implicit push depends on remote.<r>.push, push.default and upstream names; it never
		// matches an explicit refspec, so approve the exact form that will run.
		if (!t.refs) {
			const mode = exec([...git, "config", "--get", "push.default"], cwd) || "simple";
			const mapped = exec([...git, "config", "--get-all", `remote.${remote}.push`], cwd).split("\n").filter(Boolean).join(",");
			const branch = exec([...git, "branch", "--show-current"], cwd) || "unknown";
			t.refs = `implicit ${mapped ? `remote.push=${mapped}` : `push.default=${mode} branch=${branch}`}`;
		}
	}
	if (e.op === "gh.write" && !t.repo) t.repo = clean(exec(["git", "-C", dir, "remote", "get-url", "origin"], cwd)) || "unknown";
	if (["kubectl.mutate", "flux.mutate", "helm.mutate"].includes(e.op)) {
		const args = ["kubectl", "config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"];
		if (t.context) args.push("--context", t.context);
		if (t.kubeconfig) args.push("--kubeconfig", t.kubeconfig);
		t.cluster = t.server || exec(args, cwd) || "unknown";
		if (!t.namespace) {
			args[args.indexOf("-o") + 1] = "jsonpath={..namespace}";
			t.namespace = exec(args, cwd) || "default";
		}
	}
	for (const key of Object.keys(t)) t[key] = clean(t[key]);
	return { ...e, target: t, unresolved: undefined };
}

/** What an approval binds: the operation and its real target, not local aliases. */
export function identity(e: Effect): string {
	const t = { ...e.target };
	if (e.op === "git.push") delete t.dir, delete t.remote;
	if (t.cluster) delete t.context, delete t.kubeconfig;
	return JSON.stringify([e.op, Object.entries(t).sort()]);
}
const description = (e: Effect) => `${e.op} ${Object.entries(e.target).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ")}`;
const describe = (e: Effect) => plain(description(e), 300);

export function createPersonalGate(opts: { home: string; worker: boolean; exec?: Exec; alert?: (title: string, body: string) => void }) {
	const exec = opts.exec ?? run;
	let grants: { id: string; keys: Set<string>; until: number; label: string }[] = [];
	let secrets: { key: string; until: number }[] = [];
	let generation = 0, sequence = 0;
	const roots = new Map<string, string>();
	const context = (cwd: string): ClassifyContext => {
		let root = roots.get(cwd);
		if (root === undefined) roots.set(cwd, (root = canonical(exec(["git", "-C", cwd, "rev-parse", "--show-toplevel"], cwd) || cwd)));
		return { cwd: canonical(cwd), home: opts.home, projectRoot: root, realpath: canonical, env: process.env };
	};
	const effectsOf = (tool: string, input: Record<string, unknown>, cwd: string) =>
		classifyTool(tool, input, context(cwd)).filter((e) => e.class !== "opaque").map((e) => resolveEffect(e, cwd, exec));
	const secretKey = (e: Effect) => JSON.stringify([e.op, e.target.path ?? e.target.command ?? ""]);

	function check(tool: string, input: Record<string, unknown>, ctx: Pick<ExtensionContext, "cwd">): { block: true; reason: string } | undefined {
		const effects = effectsOf(tool, input, ctx.cwd), now = Date.now();
		const locked = effects.filter((e) => e.class === "secret" && !secrets.some((g) => g.until > now && g.key === secretKey(e)));
		if (locked.length) return { block: true, reason: `Secret material is blocked (${locked.map(describe).join("; ")}). Only Jan can allow one read, by typing /secret-once <path or command>.` };
		const missing = effects.filter((e) => e.class !== "secret" && !grants.some((g) => g.until > now && g.keys.has(identity(e))));
		if (missing.length) {
			const list = missing.map(describe).join("; ");
			return { block: true, reason: opts.worker
				? `Workers cannot obtain approvals (${list}). Report this step to the parent, which asks Jan and runs it.`
				: `Needs Jan's approval (${list}). Call request_approval with the commands you plan to run, this one included, and your risk analysis; do not retry until approved.` };
		}
		secrets = secrets.filter((g) => !effects.some((e) => e.class === "secret" && g.key === secretKey(e)));
		return undefined;
	}

	function register(pi: ExtensionAPI, Type: TypeBuilder) {
		pi.on("session_start", () => {
			grants = [];
			secrets = [];
			generation++;
			roots.clear();
		});
		pi.registerTool({
			name: "request_approval", label: "Request approval", exposure: "model-only", executionMode: "sequential",
			description: "Ask Jan once to approve consequential steps (publishing, pushing, cluster or system changes, sending data off the machine, deleting work, writing outside the project) before running them. List every command the plan needs; the gate derives and shows their real targets. Routine local edits, builds and tests need no approval.",
			parameters: Type.Object({
				commands: Type.Array(Type.String(), { description: "Shell commands you plan to run" }),
				paths: Type.Optional(Type.Array(Type.String(), { description: "Files outside the project you plan to write" })),
				purpose: Type.String(), consequences: Type.String(), reversibility: Type.String(), rollback: Type.Optional(Type.String()),
			}),
			async execute(_id, p, _signal, _update, ctx) {
				if (opts.worker || !ctx.hasUI) throw new Error("No approval dialog in this run. Stop and tell Jan which step needs approval; do not retry.");
				const effects = [...p.commands.flatMap((command) => effectsOf("bash", { command }, ctx.cwd)), ...(p.paths ?? []).flatMap((path) => effectsOf("write", { path }, ctx.cwd))];
				if (effects.some((e) => e.class === "secret")) throw new Error("Secret material cannot be approved here; Jan can type /secret-once <path or command>.");
				const unknown = effects.filter((e) => Object.values(e.target).includes("unknown"));
				if (unknown.length) throw new Error(`The real target of ${unknown.map(describe).join("; ")} could not be resolved. Make it explicit (remote URL, cluster context) and ask again.`);
				if (!effects.length) return text("No approval needed: these run as routine work.");
				if (effects.some(e => description(e) !== describe(e))) throw new Error("Effect description cannot be shown completely; shorten the target and ask again.");
				const facts = [...new Map(effects.map((e) => [identity(e), describe(e)])).values()];
				const title = ["Approve these effects?", ...facts.map((f) => `  • ${f}`), "", "Agent's explanation (not verified):",
					`  Purpose: ${plain(p.purpose)}`, `  Consequences: ${plain(p.consequences)}`, `  Reversibility: ${plain(p.reversibility)}`,
					...(p.rollback ? [`  Rollback: ${plain(p.rollback)}`] : [])].join("\n");
				const once = "Approve once (repeats within 15 min)", session = "Approve for this session", asked = generation;
				opts.alert?.("Pi: approval needed", facts[0]);
				let choice: string | undefined;
				pi.events?.emit("pi:approval-wait", true);
				try { choice = await ctx.ui.select(title, [once, session, "Decline"]); }
				finally { pi.events?.emit("pi:approval-wait", false); }
				if (asked !== generation) throw new Error("The session changed while asking; nothing was approved.");
				if (choice !== once && choice !== session) throw new Error("Jan declined. Do not run these steps; ask what to do instead.");
				const id = `a${++sequence}`;
				grants.push({ id, keys: new Set(effects.map(identity)), until: choice === once ? Date.now() + RETRY_MS : Infinity, label: facts.join("; ") });
				return text(`Approved ${choice === once ? "once" : "for this session"} (${id}): ${facts.join("; ")}. Anything else needs a new approval.`);
			},
		});
		pi.registerCommand("approvals", {
			description: "List approvals, or end them: /approvals revoke <id|all>",
			handler: async (args, ctx) => {
				const [action, id] = args.trim().split(/\s+/);
				if (action === "revoke") grants = grants.filter((g) => id !== "all" && g.id !== id);
				const live = grants.filter((g) => g.until > Date.now());
				ctx.ui.notify(live.map((g) => `${g.id} ${g.until === Infinity ? "session" : "once"}: ${g.label}`).join("\n") || "No active approvals", "info");
			},
		});
		pi.registerCommand("secret-once", {
			description: "Allow one read of a protected item within 15 minutes: /secret-once <path or command>",
			handler: async (args, ctx) => {
				const item = args.trim();
				const found = (/\s/.test(item) ? classifyBash(item, context(ctx.cwd)) : classifyTool("read", { path: item }, context(ctx.cwd))).filter((e) => e.class === "secret" && e.op === (/\s/.test(item) ? "secret.tool" : "secret.read"));
				for (const e of found) secrets.push({ key: secretKey(e), until: Date.now() + RETRY_MS });
				ctx.ui.notify(found.length ? `One read allowed: ${found.map(describe).join("; ")}` : `${item} is not a protected item`, "info");
			},
		});
	}

	/** Drop grep/find/ls output lines naming secret files: a search rooted above one would print it. */
	function redact(tool: string, input: Record<string, unknown> | undefined, output: string, cwd: string) {
		const raw = typeof input?.path === "string" && input.path ? input.path : ".";
		const root = resolve(cwd, raw === "~" || raw.startsWith("~/") ? opts.home + raw.slice(1) : raw);
		let hidden = 0;
		const text = output.split("\n").filter((line) => {
			const rel = tool === "grep" ? (/^(.*?)[:-]\d+[:-] /.exec(line)?.[1] ?? /^(.*?):\d+: \(unable/.exec(line)?.[1]) : line.replace(/\/$/, "");
			if (!rel || rel.startsWith("[") || /limit reached|No files found|No matches/.test(line)) return true;
			const secret = classifyTool("read", { path: isAbsolute(rel) ? rel : resolve(root, rel) }, context(cwd)).some((e) => e.class === "secret");
			if (secret) hidden++;
			return !secret;
		}).join("\n");
		return { text, hidden };
	}

	return {
		check,
		register,
		redact,
		status: () => `personal approval gate: ${grants.filter((g) => g.until > Date.now()).length} active approval(s)`,
	};
}
