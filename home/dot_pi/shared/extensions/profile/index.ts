// Pi profile support, loaded from settings.json. One set of models and sessions; the launcher only
// decides the memory scope: Work projects keep work/* memini namespaces, everything else personal.
//
// - Keeps memini separate: refuses a Work project started without the ~/.local/bin/pi launcher and
//   a session recorded under the other memory scope, and keeps pi-memini tool calls in scope.
// - Gates tools through personal-gate.ts: consequential effects need Jan's approval, secrets stay
//   blocked, and search output naming secret files is redacted.
// - Registers the `advisor` tool (advisor.ts): a read-only second opinion from fable/astra.
// - Tracks how much of each subscription is used (usage.ts, usage-sources.ts). `/usage`, usage_status.
// - Shows the memory scope in the footer; the footer shows the native model.
//
// This is configuration inside one OS user, not a sandbox: anything the Pi process can read
// (including other tools' credential files) is reachable by its tools.

import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { memoryToolBlock, type Profile } from "./memory-scope.ts";
import { createPersonalGate } from "./personal-gate.ts";
import { registerAdvisor } from "./advisor.ts";
import { DEFAULT_USAGE, USAGE_POOLS, poolOf, isQuotaError, describe as describeUsage, limitedUntilFrom, pressure, shortTime } from "./usage.ts";
import { renderBars, renderPanel, type PoolView } from "./usage-view.ts";
import { stripAiTrailers } from "./commit-trailers.ts";
import { renderFooter } from "./footer-view.ts";
import { duration, notify, notifyAfterMs } from "./notify.ts";
import { acquire, holder, inUseMessage, ownIdentity, release, type LockOwner } from "./session-lock.ts";
import { detachInfo, removeMeta, repaint, writeMeta } from "./detach.ts";
import { readCache, writeCache, type UsageCache } from "./usage-sources.ts";
import { claimCheckout, type CheckoutDelegation } from "../subagent/checkout.ts";

const HOME = homedir();
const PERSONAL_DIR = join(HOME, ".pi", "agent");
const WORK_ROOT = join(HOME, "Work");
const EXT_DIR = join(HOME, ".pi", "shared", "extensions", "profile");
const STAMP = "pi-profile";
const GUARD = Symbol.for("pi-profile.request-guard");

const canon = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
const inside = (p: string, root: string) => fold(p) === fold(root) || fold(p).startsWith(fold(root) + sep);

/** The profile the launcher would pick here: its own resolver, else a minimal cwd/repo check. */
function expectedProfile(cwd: string): Profile {
	const helper = join(HOME, ".local", "bin", "pi-profile");
	if (existsSync(helper)) {
		const { AI_PROFILE: _, ...env } = process.env;
		const r = spawnSync(helper, [], { cwd, env: { ...env, PI_MEMINI: "off" }, encoding: "utf8", timeout: 5000 });
		const m = /^profile=(work|personal)$/m.exec(r.stdout ?? "");
		if (m) return m[1] as Profile;
	}
	const root = canon(WORK_ROOT);
	if (inside(canon(cwd), root)) return "work";
	const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 2000 });
	return git.status === 0 && inside(canon(git.stdout.trim()), root) ? "work" : "personal";
}

/** Notify in the TUI; print, JSON and RPC runs have no notification area, so use stderr. */
const say = (ctx: { hasUI: boolean; ui: { notify(m: string, t?: "info" | "warning" | "error"): void } }, msg: string, level: "info" | "warning" | "error") =>
	ctx.hasUI ? ctx.ui.notify(msg, level) : console.error(msg);

export default function profileExtension(pi: ExtensionAPI) {
	const agentDir = canon(process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, HOME) || PERSONAL_DIR);
	const asProfile = (v: string | undefined) => (v === "work" || v === "personal" ? v : undefined);
	const declared = asProfile(process.env.AI_PROFILE);
	// `profile` is only the memory scope the launcher chose; models, sessions and tools are shared.
	const profile: Profile = declared ?? "personal";
	const models: Profile = "personal";
	const worker = process.env.PI_WORKER === "1";
	let memState = process.env.PI_MEMINI_STATE ?? "unchecked: started without the pi launcher";
	let memoryOff = memState.startsWith("off") ? memState.replace(/^off:?\s*/, "") || "off" : undefined;
	pi.events.on("memini:load-error", (message: unknown) => {
		memState = `degraded: ${message}`;
		memoryOff = "memini extension failed to load";
	});

	// Process-wide problems block every request, tool call and prompt; session problems only
	// while that session is open.
	let processBlock: string | undefined;
	let sessionBlock: string | undefined;
	let stamped = false;
	const blocked = () => processBlock ?? sessionBlock;

	// --- one process per session file (session-lock.ts) ---------------------------------------

	// Kept on globalThis so a /reload, which re-runs this module, keeps the locks this process
	// already holds instead of dropping and re-taking them (someone else could get in between).
	const locks: { held: Map<string, LockOwner>; hooked: boolean } = ((globalThis as any).__piProfileLocks ??= { held: new Map(), hooked: false });
	const argv = process.argv.join(" ");
	const lockMode: LockOwner["mode"] = /--mode(?:=|\s+)rpc\b/.test(argv) ? "rpc" : process.stdout.isTTY ? "tui" : "print";
	const detach = detachInfo();
	let exitMessage: string | undefined;
	const releaseAll = (except?: string) => {
		for (const [file, me] of locks.held) {
			if (file === except) continue;
			release(file, me);
			locks.held.delete(file);
		}
	};
	if (!locks.hooked) {
		locks.hooked = true;
		process.on("exit", () => {
			releaseAll();
			const d = detachInfo();
			if (d) removeMeta(d);
			if (exitMessage) process.stderr.write(`${exitMessage}\n`);
		});
	}

	if (process.env.AI_PROFILE && !declared) {
		processBlock = `pi-profile: unknown AI_PROFILE=${process.env.AI_PROFILE}`;
	} else if (!worker && profile === "personal" && expectedProfile(process.cwd()) === "work") {
		// Personal memory must never open in a Work project. Work scope is sticky by design: the launcher
		// keeps a Work session's children on work/* even outside the Work tree.
		processBlock = `pi-profile: ${process.cwd()} needs Work memory scope; restart with \`pi\`.`;
	}
	const publishMemoryBlock = () => { (globalThis as any)[Symbol.for("pi-profile.memory-block")] = blocked(); };
	publishMemoryBlock();

	const gate = createPersonalGate({ home: HOME, worker, alert: notify });

	// --- subscription usage --------------------------------------------------------------

	// A detached helper refreshes the fixed subscription pools without delaying requests.
	const usageFile = join(agentDir, "usage.json");
	const usageOpts = DEFAULT_USAGE;
	const pools = worker ? [] : [...USAGE_POOLS];
	let usage: UsageCache = readCache(usageFile);
	let usageMtime = 0;
	const reloadUsage = () => {
		try {
			const m = statSync(usageFile).mtimeMs;
			if (m !== usageMtime) {
				usageMtime = m;
				usage = readCache(usageFile);
			}
		} catch {
			// no cache yet
		}
	};
	const stalePools = () => pools.filter((p) => !usage[p] || Date.now() - Date.parse(usage[p].fetchedAt) > usageOpts.refreshMinutes * 60_000);
	let lastKick = 0;
	const kickRefresh = (list: string[]) => {
		if (!list.length || Date.now() - lastKick < 30_000 || processBlock) return;
		lastKick = Date.now();
		const strip = Number(process.versions.node.split(".")[0]) < 23 ? ["--experimental-strip-types"] : [];
		try {
			spawn(process.execPath, [...strip, join(EXT_DIR, "usage-refresh.ts"), agentDir, ...list], { detached: true, stdio: "ignore", env: process.env }).unref();
		} catch {
			// usage stays as cached
		}
	};
	const pressureOf = (t: { provider: string; model: string }) => {
		const pool = poolOf(t);
		return pool ? pressure(usage[pool], t.model, Date.now(), usageOpts) : undefined;
	};
	const markLimited = (model: { provider: string; model: string }, errorText: string) => {
		const pool = poolOf(model);
		if (!pool) return;
		reloadUsage();
		const until = limitedUntilFrom(errorText, Date.now());
		usage[pool] = { ...(usage[pool] ?? { sub: pool, label: pool, windows: [], fetchedAt: new Date(0).toISOString() }), limitedUntil: until };
		try { writeCache(usageFile, usage); } catch { /* in-memory only */ }
	};
	let activePool: string | undefined;
	const noteActive = (model: { provider: string; id?: string; model?: string } | undefined) => {
		activePool = model ? poolOf(model) : undefined;
	};
	const poolViews = (): PoolView[] => pools.map((p) => ({ name: p === "opencode-go" ? "go" : p, u: usage[p], active: p === activePool }));
	const showBars = (ctx: any) => {
		if (!pools.length || !ctx?.hasUI) return;
		ctx.ui.setWidget(
			"pi-usage",
			(_tui: unknown, theme: any) => ({ render: (width: number) => [renderBars(poolViews(), Date.now(), usageOpts, theme, width)], invalidate() {} }),
			{ placement: "belowEditor" },
		);
	};

	// Notify once when a window passes 85% (re-armed below 75%) and when a limited subscription is
	// usable again. The first call after start only records the state.
	const alerted = new Set<string>();
	const wasLimited = new Set<string>();
	let alertsSeeded = false;
	const checkAlerts = (ctx: any) => {
		if (!ctx?.hasUI) return;
		const now = Date.now();
		for (const p of pools) {
			const u = usage[p];
			if (!u) continue;
			const fresh = now - Date.parse(u.fetchedAt) <= usageOpts.staleMinutes * 60_000;
			const limited = (!!u.limitedUntil && Date.parse(u.limitedUntil) > now) || !!u.limitReached;
			if (alertsSeeded && fresh && wasLimited.has(p) && !limited) ctx.ui.notify(`${u.label} is available again`, "info");
			if (limited) wasLimited.add(p);
			else wasLimited.delete(p);
			if (!fresh) continue;
			for (const w of u.windows) {
				const key = `${p}:${w.name}`;
				if ((w.resetsAt && Date.parse(w.resetsAt) <= now) || w.usedPct < 75) alerted.delete(key);
				else if (w.usedPct >= 85 && !alerted.has(key)) {
					alerted.add(key);
					if (alertsSeeded) ctx.ui.notify(`${u.label} ${w.name} at ${Math.round(w.usedPct)}%${w.resetsAt ? ` (resets ${shortTime(w.resetsAt, now)})` : ""}`, "warning");
				}
			}
		}
		alertsSeeded = true;
	};

	let footerTui: { requestRender(): void } | undefined;
	if (!worker) {
		registerAdvisor(pi, { blocked, pressureOf });
		gate.register(pi, Type);
	}

	// --- request guard --------------------------------------------------------------

	// A blocked process or session (memory scope unsafe) must not reach any model. Supported hooks
	// cannot veto every request, so the block is also enforced at ModelRuntime.prepareRequest, which
	// every model request passes. Not documented API: if it
	// disappears, input and tool calls still refuse.
	const requestBlock = (_model?: unknown): string | undefined => blocked();

	// Installed on the exported ModelRuntime class while the extension loads, so it is in place
	// before any extension's session_start can make a call. On /reload the new instance's check
	// replaces the old one.
	const proto = (ModelRuntime as any)?.prototype;
	const guardInstalled = !!proto && typeof proto.prepareRequest === "function";
	if (guardInstalled) {
		const holder = (proto[GUARD] ??= { original: proto.prepareRequest, check: undefined });
		if (proto.prepareRequest === holder.original) {
			proto.prepareRequest = function (model: any, options: unknown) {
				const why = holder.check?.(model);
				return why ? Promise.reject(new Error(why)) : holder.original.call(this, model, options);
			};
		}
		holder.check = requestBlock;
	}

	// --- session lifecycle --------------------------------------------------------------

	const status = () => {
		const mem = memState.startsWith("ok: ") ? memState.slice(4).replace(/ \(.*\)$/, "") : memState.split(":")[0];
		return `${profile} · mem ${mem}${blocked() ? " · BLOCKED" : ""}`;
	};

	// Replaces Pi's footer with scope, place, memory, native model and context.
	const OWN_STATUSES = new Set(["pi-profile"]);
	const showFooter = (ctx: any) => {
		if (worker || !ctx?.hasUI) return;
		ctx.ui.setFooter((tui: any, theme: any, data: any) => {
			footerTui = tui;
			(globalThis as any).__piProfileFooterTui = tui;
			const unsub = data.onBranchChange(() => tui.requestRender());
			return {
				dispose() {
					unsub();
					if (footerTui === tui) footerTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const m = ctx.model;
					const usage = ctx.getContextUsage?.();
					const statuses = [...data.getExtensionStatuses().entries()]
						.filter(([k]: [string, string]) => !OWN_STATUSES.has(k))
						.sort(([a]: [string, string], [b]: [string, string]) => a.localeCompare(b))
						.map(([, v]: [string, string]) => String(v).replace(/\s+/g, " ").trim())
						.filter(Boolean);
					return renderFooter(
						{
							profile,
							blocked: !!blocked(),
							cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
							home: HOME,
							branch: data.getGitBranch() ?? undefined,
							sessionName: ctx.sessionManager.getSessionName?.() ?? undefined,
							memory: memState,
							model: m ? { provider: m.provider, id: m.id } : undefined,
							thinking: m?.reasoning ? pi.getThinkingLevel() : undefined,
							context: usage ? { percent: usage.percent, window: usage.contextWindow } : m?.contextWindow ? { percent: null, window: m.contextWindow } : undefined,
							statuses,
						},
						theme,
						width,
					);
				},
			};
		});
	};

	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let liveCtx: any;
	pi.on("session_shutdown", () => {
		if (usageTimer) clearInterval(usageTimer);
		usageTimer = undefined;
		liveCtx = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		if (worker) return;
		liveCtx = ctx;
		reloadUsage();
		kickRefresh(stalePools());
		if (!usageTimer && pools.length) {
			usageTimer = setInterval(() => {
				kickRefresh(stalePools());
				reloadUsage();
				try {
					liveCtx?.ui.setStatus("pi-profile", status());
					showBars(liveCtx);
					checkAlerts(liveCtx);
				} catch {
					// session being replaced
				}
			}, usageOpts.refreshMinutes * 60_000);
			usageTimer.unref?.();
		}
		sessionBlock = undefined;
		const sessionFile: string | undefined = ctx.sessionManager.getSessionFile();
		if (sessionFile && !locks.held.has(sessionFile)) {
			const me = ownIdentity(lockMode, detach?.id);
			const got = acquire(sessionFile, me);
			if (got.ok) {
				locks.held.set(sessionFile, me);
				releaseAll(sessionFile);
			} else {
				// Stop rather than stay open on a session another process is writing. Without a UI
				// (pi -p, T3's RPC) the blocked request reports it; the TUI shows it, then repeats
				// it on the terminal after leaving the alternate screen.
				sessionBlock = inUseMessage(sessionFile, got.owner, got.reason);
				publishMemoryBlock();
				if (ctx.hasUI) {
					exitMessage = sessionBlock;
					say(ctx, sessionBlock, "error");
				}
				setTimeout(() => ctx.shutdown(), ctx.hasUI ? 1500 : 0);
				return;
			}
		}
		if (detach)
			try {
				writeMeta(detach, { pid: process.pid, cwd: ctx.cwd, profile, session: sessionFile, name: ctx.sessionManager.getSessionName?.(), started: new Date().toISOString() });
			} catch {
				// pi-attach then lists it without details
			}
		const stamp = ctx.sessionManager
			.getEntries()
			.find((e: any) => e.type === "custom" && e.customType === STAMP) as { data?: { profile?: string } } | undefined;
		stamped = !!stamp;
		const file = ctx.sessionManager.getSessionFile();
		if (stamp?.data?.profile && stamp.data.profile !== profile) {
			sessionBlock = `pi-profile: this session was recorded with ${stamp.data.profile} memory; it cannot continue with ${profile} memory. Open it from a ${stamp.data.profile === "work" ? "Work" : "non-Work"} directory: pi --session ${file ?? "<file>"}.`;
		}
		publishMemoryBlock();
		ctx.ui.setStatus("pi-profile", status());
		noteActive(ctx.model);
		showFooter(ctx);
		showBars(ctx);
		checkAlerts(ctx);
		const why = blocked();
		if (why) say(ctx, why, "error");
		// The launcher already printed this on stderr; repeat it where the TUI can show it.
		else if (ctx.hasUI && !memState.startsWith("ok")) ctx.ui.notify(`memini ${memState}`, memoryOff ? "info" : "warning");
	});

	// Do not leave the current session for one another process has open.
	pi.on("session_before_switch", (event: any, ctx: any) => {
		const target: string | undefined = event.targetSessionFile;
		if (!target || locks.held.has(target)) return undefined;
		const owner = holder(target);
		if (!owner) return undefined;
		say(ctx, inUseMessage(target, owner, "held").replace(", so this one stops here", ""), "error");
		return { cancel: true };
	});
	pi.on("session_shutdown", (event: any) => {
		// A switch keeps the old lock until session_start has taken the new one; /reload keeps it.
		if (event.reason === "quit") {
			releaseAll();
			if (detach) removeMeta(detach);
		}
	});
	// pi-attach sends SIGUSR2 once a new terminal is attached: replay the terminal setup, repaint.
	if (detach && !(globalThis as any).__piProfileRepaint) {
		(globalThis as any).__piProfileRepaint = true;
		process.on("SIGUSR2", () => repaint((globalThis as any).__piProfileFooterTui));
	}

	// Stamp on the first real turn rather than at startup, so opening Pi does not create a session.
	pi.on("before_agent_start", () => {
		if (!stamped && !blocked()) {
			pi.appendEntry(STAMP, { profile, models });
			stamped = true;
		}
	});

	// --- model and input guards -----------------------------------------------------------

	pi.on("model_select", (event) => { noteActive(event.model); });

	pi.on("input", (event, ctx) => {
		const why = blocked();
		// Only the TUI can explain a swallowed prompt. Elsewhere the prompt proceeds and the
		// request guard fails it with the same reason and a non-zero exit.
		if (!why || !ctx.hasUI) return { action: "continue" as const };
		ctx.ui.notify(why, "error");
		return { action: "handled" as const };
	});

	const checkoutCalls = new Map<string, ReturnType<typeof claimCheckout>>();
	pi.on("tool_execution_end", event => { checkoutCalls.get(event.toolCallId)?.release(); checkoutCalls.delete(event.toolCallId); });
	pi.on("session_shutdown", () => { for (const lease of checkoutCalls.values()) lease.release(); checkoutCalls.clear(); });
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const why = blocked() ?? memoryToolBlock(profile, event.toolName, input, { home: process.env.MEMINI_HOME, memoryOff });
		if (why) return { block: true, reason: why };
		// No AI attribution in commits, whichever model is answering. Edited in place so the
		// gate below judges the command that will actually run.
		if (event.toolName === "bash" && typeof input?.command === "string") {
			const fix = stripAiTrailers(input.command);
			if (fix?.leftover)
				return { block: true, reason: `Commits must not credit an AI model or agent. Remove "${fix.leftover}" from the commit message and commit again.` };
			if (fix) input.command = fix.command;
		}
		const denied = gate.check(event.toolName, input, ctx); if (denied) return denied;
		if (["bash", "edit", "write"].includes(event.toolName)) {
			try {
				const delegated: CheckoutDelegation | undefined = worker && process.env.PI_WORKER_CHECKOUT ? JSON.parse(process.env.PI_WORKER_CHECKOUT) : undefined;
				checkoutCalls.set(event.toolCallId, claimCheckout(ctx.cwd, false, false, delegated));
			} catch (e) { return { block: true, reason: `Checkout coordination: ${e}` }; }
		}
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!["grep", "find", "ls"].includes(event.toolName)) return undefined;
		let hidden = 0;
		const content = event.content.map((c) => {
			if (c.type !== "text") return c;
			const r = gate.redact(event.toolName, event.input as Record<string, unknown>, c.text, ctx.cwd);
			hidden += r.hidden;
			return { ...c, text: r.text };
		});
		if (!hidden) return undefined;
		content.push({ type: "text", text: `[${hidden} result(s) hidden: they name secret files]` });
		return { content };
	});

	// --- notifications ------------------------------------------------------------------------

	// A run that took long enough for you to look away ends with a terminal notification.
	let runStarted = 0;
	pi.on("agent_start", () => {
		if (!runStarted) runStarted = Date.now();
	});
	pi.on("agent_settled", (event, ctx) => {
		const took = runStarted ? Date.now() - runStarted : 0;
		runStarted = 0;
		// Pi >= 1.1 says when you cancelled the run yourself; older Pi leaves `aborted` unset.
		if ((event as { aborted?: boolean }).aborted) return;
		if (took >= notifyAfterMs()) notify(`Pi · ${basename(ctx.cwd)}`, `Done in ${duration(took)}, ready for input`);
	});

	// Preserve quota visibility without changing the provider's error or selected model.
	pi.on("message_end", (event, ctx) => {
		if (worker) return;
		const m = event.message as any;
		if (m?.role !== "assistant") return;
		const pool = poolOf(m);
		if (m.stopReason === "error" && isQuotaError(m.errorMessage)) markLimited(m, m.errorMessage ?? "");
		else if (pool && (!usage[pool] || Date.now() - Date.parse(usage[pool].fetchedAt) > 120_000)) kickRefresh([pool]);
		if (m.stopReason !== "error") noteActive(m);
		reloadUsage();
		ctx.ui.setStatus("pi-profile", status());
		checkAlerts(ctx);
	});

	const workerBlock = (model?: { provider: string; id: string }) => blocked() ?? (model ? undefined : "Worker model unavailable");
	if (worker) return { workerBlock };

	// --- usage visibility ----------------------------------------------------------------------------

	const usageReport = (): string => {
		reloadUsage();
		const now = Date.now();
		return pools.map((p) => usage[p] ? describeUsage(usage[p], now, usageOpts) : `${p}: not fetched yet`).join("\n");
	};

	pi.registerTool({
		name: "usage_status",
		label: "Usage",
		description:
			"Show how much of each of the user's AI subscriptions (Claude, ChatGPT/Codex, OpenCode Go, MiniMax) is used. Use it before choosing a model, subagent or advisor for a large task.",
		promptSnippet: "usage_status: subscription usage",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: usageReport() }], details: undefined };
		},
	});

	pi.registerCommand("usage", {
		description: "Show subscription usage (`/usage refresh` to re-read now)",
		handler: async (args, ctx) => {
			if (args.trim() === "refresh") {
				lastKick = 0;
				kickRefresh(pools);
				ctx.ui.notify("Refreshing usage in the background; run /usage again in a few seconds.", "info");
				return;
			}
			if (!ctx.hasUI || !pools.length) {
				ctx.ui.notify(usageReport(), "info");
				return;
			}
			reloadUsage();
			await ctx.ui.custom<void>((_tui: unknown, theme: any, _kb: unknown, done: (r?: void) => void) => ({
				render: (width: number) => renderPanel(poolViews(), Date.now(), usageOpts, theme, width),
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q" || data === " ") done();
				},
				invalidate() {},
			}));
		},
	});

	// --- diagnostics ----------------------------------------------------------------------------

	pi.registerCommand("profile", {
		description: "Show memory scope, accounts and approval status",
		handler: async (_args, ctx) => {
			const lines = [
				`memory scope: ${profile}  (agent dir ${agentDir})`,
				`sessions: ${process.env.PI_CODING_AGENT_SESSION_DIR ?? `${agentDir}/sessions`}`,
				`claude config: ${process.env.CLAUDE_CONFIG_DIR ?? "(unset — bridge uses ~/.claude)"}`,
				`memini: ${memState}`,
				`namespace env: prefix=${process.env.MEMINI_NAMESPACE_PREFIX ?? "-"} namespace=${process.env.MEMINI_NAMESPACE ?? "-"} home=${process.env.MEMINI_HOME ?? "-"}`,
				blocked() ? `BLOCKED: ${blocked()}` : "requests: allowed",
				gate.status(),
				`selected: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "-"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	return { workerBlock };
}

// Exported for tests.
export { expectedProfile };
