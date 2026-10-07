// Work/Personal profile support for Pi, loaded by both profiles' settings.json.
//
// - Registers the virtual models from ~/.pi/shared/routing.json under the profile's own provider
//   id (personal/daily, work/fast, ...) with deterministic chains and bounded fallback.
// - Enforces the Work provider allowlist on every request Pi makes (main turns, retries,
//   compaction, summaries and extension calls all pass ModelRuntime.prepareRequest), on model
//   selection and on input, and keeps project config from widening it.
// - Refuses to run a Work project or a Work session under the Personal profile (and the reverse
//   for sessions), e.g. when `pi` was started without the ~/.local/bin/pi launcher.
// - Supports the launcher's explicit Work override (`--personal-models`): a Work session (Work
//   session store, work/* memory, Work trust rules) that runs on the Personal models and says so.
// - Keeps pi-memini tool calls inside the profile's memory scope.
// - In Work, applies the organisation's Claude Code permission policy to Pi's own tools
//   (permissions.ts): the bridge has Claude Code relay them, so Claude Code cannot.
// - Registers the `advisor` tool (advisor.ts): a read-only second opinion from fable/astra.
// - Tracks how much of each subscription is used (usage.ts, usage-sources.ts) and routes on it;
//   `auto` lets a classifier model (MiniMax) pick the tier per prompt. `/usage`, usage_status.
// - Shows the profile and memory scope in the footer; the footer already shows the routed model.
//
// This is account and configuration isolation inside one OS user, not a sandbox: anything the Pi
// process can read (including other tools' credential files) is reachable by its tools.

import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import {
	chooseRoute,
	classifyError,
	conversationFacts,
	failureHint,
	fallbackMarker,
	loadRouting,
	memoryToolBlock,
	nextFallback,
	providerAllowed,
	AUTO_CLASSIFIER_PROMPT,
	DEFAULT_USAGE,
	decideTier,
	isShortFollowUp,
	parseDecision,
	decisionsRequest,
	parseTier,
	poolOf,
	usagePolicy,
	type ModelInfo,
	type TargetPressure,
	type Profile,
	type RouterState,
	type RoutingConfig,
} from "./policy.ts";
import { bashScope, decide, parseOrgPolicy, parsePersonalPolicy, redactSearchOutput, type Approvals, type OrgPolicy } from "./permissions.ts";
import { registerAdvisor } from "./advisor.ts";
import { describe as describeUsage, limitedUntilFrom, pressure, shortTime } from "./usage.ts";
import { renderBars, renderPanel, type PoolView } from "./usage-view.ts";
import { stripAiTrailers } from "./commit-trailers.ts";
import { renderFooter, type FooterState } from "./footer-view.ts";
import { duration, notify, notifyAfterMs } from "./notify.ts";
import { acquire, holder, inUseMessage, ownIdentity, release, type LockOwner } from "./session-lock.ts";
import { detachInfo, removeMeta, repaint, writeMeta } from "./detach.ts";
import { readCache, SOURCES, writeCache, type UsageCache } from "./usage-sources.ts";

const HOME = homedir();
const PERSONAL_DIR = join(HOME, ".pi", "agent");
const WORK_DIR = join(HOME, ".pi", "profiles", "work", "agent");
const WORK_ROOT = join(HOME, "Development", "Work");
const ROUTING = join(HOME, ".pi", "shared", "routing.json");
const EXT_DIR = join(HOME, ".pi", "shared", "extensions", "profile");
const PERSONAL_POLICY = join(HOME, ".pi", "shared", "personal-policy.json");
// Claude Code caches the enterprise's server-managed settings beside the Work login.
const ORG_POLICY = join(WORK_DIR, "claude", "remote-settings.json");
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

function workProjectRisks(cwd: string): string[] {
	const dir = join(cwd, ".pi");
	const risks: string[] = [];
	if (existsSync(join(dir, "extensions"))) risks.push(".pi/extensions");
	if (existsSync(join(dir, "mcp.json"))) risks.push(".pi/mcp.json");
	try {
		const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		for (const k of ["packages", "extensions", "defaultProvider", "defaultModel", "enabledModels", "npmCommand", "shellPath", "shellCommandPrefix"])
			if (k in s) risks.push(`.pi/settings.json ${k}`);
	} catch {
		// absent or unreadable: nothing to load either
	}
	return risks;
}

/** Notify in the TUI; print, JSON and RPC runs have no notification area, so use stderr. */
const say = (ctx: { hasUI: boolean; ui: { notify(m: string, t?: "info" | "warning" | "error"): void } }, msg: string, level: "info" | "warning" | "error") =>
	ctx.hasUI ? ctx.ui.notify(msg, level) : console.error(msg);

const modelInfo = (m: any): ModelInfo | undefined =>
	m ? { provider: m.provider, id: m.id, input: m.input ?? ["text"], contextWindow: m.contextWindow ?? 0 } : undefined;

export default function profileExtension(pi: ExtensionAPI) {
	const agentDir = canon(process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, HOME) || PERSONAL_DIR);
	const dirProfile: Profile = agentDir === canon(WORK_DIR) ? "work" : "personal";
	const asProfile = (v: string | undefined) => (v === "work" || v === "personal" ? v : undefined);
	const declared = asProfile(process.env.AI_PROFILE);
	// `profile` owns the session store, memory scope and trust rules; `models` decides which
	// virtual models exist and which providers may be called. They differ only under the
	// launcher's Work override, where a Work session runs on the Personal agent dir's models.
	const profile: Profile = declared ?? dirProfile;
	const models: Profile = declared ? (asProfile(process.env.AI_PROFILE_MODELS) ?? declared) : dirProfile;
	const override = profile === "work" && models === "personal";
	const otherDir = canon(profile === "work" ? PERSONAL_DIR : WORK_DIR);
	const memState = process.env.PI_MEMINI_STATE ?? "unchecked: started without the pi launcher";
	const memoryOff = memState.startsWith("off") ? memState.replace(/^off:?\s*/, "") || "off" : undefined;

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
	} else if (declared && (models !== dirProfile || (profile === "personal" && models === "work"))) {
		processBlock = `pi-profile: the launcher selected ${profile}${override ? " on personal models" : ""} but Pi is running with the ${dirProfile} agent dir (${agentDir}). Restart with \`pi\` or \`piw\`.`;
	} else if (!declared && profile === "personal" && expectedProfile(process.cwd()) === "work") {
		processBlock = `pi-profile: ${process.cwd()} is a Work project but Pi started with the Personal profile (bypassing the pi launcher). Nothing was sent; restart with \`pi\`.`;
	}

	let cfg: RoutingConfig | undefined;
	let cfgError: string | undefined;
	try {
		cfg = loadRouting(JSON.parse(readFileSync(ROUTING, "utf8")));
	} catch (e) {
		cfgError = `pi-profile: ${ROUTING}: ${(e as Error).message}`;
		// Without a validated map there is no allowlist to enforce, so Work fails closed.
		if (profile === "work") processBlock ??= cfgError;
	}

	// --- organisation tool policy (Work) ----------------------------------------------

	let orgPolicy: OrgPolicy | undefined;
	let orgPolicyError: string | undefined;
	let personalPolicyMissing: string | undefined;
	if (profile === "work") {
		try {
			orgPolicy = parseOrgPolicy(JSON.parse(readFileSync(ORG_POLICY, "utf8")));
		} catch (e) {
			// Fail closed: without the org's rules Work tools stay off.
			orgPolicyError = `pi-profile: Work tools are off until your organisation's Claude policy can be read (${ORG_POLICY}: ${(e as Error).message}). Log the Work profile in once: pi-profile --work login`;
		}
	} else {
		// Personal: the rules in ~/.pi/shared/personal-policy.json ask or refuse; everything else runs.
		// A file that exists but cannot be read fails closed like Work, so a typo never silently
		// drops the approvals; a missing file (an older deploy) runs without a policy, with a warning.
		try {
			orgPolicy = parsePersonalPolicy(JSON.parse(readFileSync(PERSONAL_POLICY, "utf8")));
		} catch (e) {
			if (existsSync(PERSONAL_POLICY))
				orgPolicyError = `pi-profile: Personal tools are off until ${PERSONAL_POLICY} is fixed (${(e as Error).message})`;
			else personalPolicyMissing = `pi-profile: no Personal tool policy (${PERSONAL_POLICY} is missing); every tool runs without asking. Run chezmoi apply.`;
		}
	}
	const policyName = profile === "work" ? "Work policy" : "Personal policy";
	// Session approvals ("allow for this session") reach subagents and the advisor, which run
	// headless and cannot ask, through the environment they inherit.
	const approvals: Approvals = (() => {
		try {
			const a = JSON.parse(process.env.PI_PROFILE_APPROVALS ?? "{}");
			return { bash: Array.isArray(a.bash) ? a.bash : [], tools: Array.isArray(a.tools) ? a.tools : [] };
		} catch {
			return { bash: [], tools: [] };
		}
	})();
	const approve = (kind: "bash" | "tools", value: string) => {
		if (!approvals[kind].includes(value)) approvals[kind].push(value);
		process.env.PI_PROFILE_APPROVALS = JSON.stringify(approvals);
	};

	// --- subscription usage --------------------------------------------------------------

	// Pools the profile's chains, advisors and auto classifier draw on. A detached helper
	// (usage-refresh.ts) refreshes <agent-dir>/usage.json; routing only ever reads the file, so it
	// never waits on the network and print-mode runs exit as soon as they answer.
	const usageFile = join(agentDir, "usage.json");
	const usageOpts = cfg ? usagePolicy(cfg) : DEFAULT_USAGE;
	const pools = cfg
		? [
				...new Set(
					[
						...Object.values(cfg.profiles[models].models).flatMap((v) => v.chain.map((t) => poolOf(cfg!, t))),
						...Object.values(cfg.advisors?.[models]?.models ?? {}).map((t) => poolOf(cfg!, t)),
						...(cfg.profiles[models].auto ? [poolOf(cfg, cfg.profiles[models].auto!.classifier)] : []),
					].filter((p): p is string => !!p && p in SOURCES),
				),
			]
		: [];
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
			spawn(process.execPath, [...strip, join(EXT_DIR, "usage-refresh.ts"), agentDir, models, ...list], { detached: true, stdio: "ignore", env: process.env }).unref();
		} catch {
			// usage stays as cached
		}
	};
	const pressureOf = (t: { provider: string; model: string; usage?: string }): TargetPressure | undefined => {
		const pool = cfg ? poolOf(cfg, t) : undefined;
		return pool ? pressure(usage[pool], t.model, Date.now(), usageOpts) : undefined;
	};
	const markLimited = (provider: string, errorText: string) => {
		const pool = cfg ? poolOf(cfg, { provider }) : undefined;
		if (!pool) return;
		reloadUsage();
		const until = limitedUntilFrom(errorText, Date.now());
		usage[pool] = { ...(usage[pool] ?? { sub: pool, label: pool, windows: [], fetchedAt: new Date(0).toISOString() }), limitedUntil: until };
		try {
			writeCache(usageFile, usage);
		} catch {
			// in-memory only
		}
	};
	// The subscription serving the last reply (or the selected model), marked in the bars.
	let activePool: string | undefined;
	const noteActive = (provider: string | undefined) => {
		const pool = cfg && provider ? poolOf(cfg, { provider }) : undefined;
		if (pool && pools.includes(pool)) activePool = pool;
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

	// Where the request in flight went (set by route(), cleared when its reply lands); after that
	// the footer reads the model from the session, so it survives /reload and resumed sessions.
	let lastRoute: FooterState["route"];
	let autoWhy: string | undefined;
	let footerTui: { requestRender(): void } | undefined;
	const noteRoute = (r: NonNullable<FooterState["route"]>) => {
		lastRoute = r;
		footerTui?.requestRender();
	};

	// --- virtual models -----------------------------------------------------------

	for (const [id, spec] of Object.entries(cfg?.profiles[models].models ?? {})) {
		pi.registerVirtualModel<RouterState>({
			provider: models,
			id,
			name: `${spec.name} (${override ? "work on personal models" : models})`,
			thinkingLevels: [spec.level],
			route(request, ctx) {
				const why = blocked();
				if (why) throw new Error(why);
				if (request.reason === "user") {
					reloadUsage();
					kickRefresh(stalePools());
				}
				const registry = ctx.modelRegistry;
				const choice = chooseRoute({
					pressure: pressureOf,
					cfg: cfg!,
					profile: models,
					virtualId: id,
					reason: request.reason,
					previous: request.previous && { provider: request.previous.model.provider, id: request.previous.model.id },
					failed: request.failed && {
						provider: request.failed.model.provider,
						id: request.failed.model.id,
						errorMessage: request.failed.message.errorMessage,
					},
					state: request.state,
					...conversationFacts(request.messages),
					now: Date.now(),
					lookup: (provider, model) => modelInfo(registry.find(provider, model)),
					hasAuth: (info) => {
						const m = registry.find(info.provider, info.id);
						return !!m && registry.hasConfiguredAuth(m);
					},
				});
				if (choice.note) say(ctx, choice.note, "warning");
				noteRoute({ model: choice.target.model, thinking: choice.target.thinking });
				return {
					model: registry.find(choice.target.provider, choice.target.model)!,
					thinkingLevel: choice.target.thinking,
					state: choice.state,
				};
			},
		});
	}

	// `auto`: a classifier model picks the tier (daily, deep, fast, ...) for each new prompt; the
	// tier's own chain then picks the model. Follow-ups, tool loops and compaction stay put.
	type AutoState = { tier?: string; byTier?: Record<string, RouterState> };
	const auto = cfg?.profiles[models].auto;
	const lastUserText = (messages: readonly any[]): string => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role !== "user") continue;
			return typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
		}
		return "";
	};
	// The prompt the user typed. Extensions such as memini add custom messages after it, and those
	// reach the router as user messages too, so the session branch (where they stay `custom_message`
	// entries) is asked first.
	const typedText = (ctx: any, messages: readonly any[]): string => {
		const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e?.type === "message" && e.message?.role === "user") return lastUserText([e.message]);
		}
		return lastUserText(messages);
	};
	const lastAssistantText = (messages: readonly any[]): string => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role === "assistant") return (m.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ").slice(0, 400);
		}
		return "";
	};
	if (auto && cfg) {
		pi.registerVirtualModel<AutoState>({
			provider: models,
			id: "auto",
			name: `${auto.name} (${override ? "work on personal models" : models})`,
			thinkingLevels: ["medium"],
			async route(request, ctx) {
				const why = blocked();
				if (why) throw new Error(why);
				const registry = ctx.modelRegistry;
				const facts = conversationFacts(request.messages);
				let tier = request.state?.tier;
				let note = "";
				if (request.reason === "user") {
					reloadUsage();
					kickRefresh(stalePools());
					const text = typedText(ctx, request.messages);
					const c = auto.classifier;
					const classifier = registry.find(c.provider, c.model);
					let proposed: { tier: string; why: string } | undefined;
					if (text && !isShortFollowUp(text)) {
						const prompt =
							`Current tier: ${tier ?? auto.default}\nConversation: ${request.messages.length} messages, ~${facts.estimatedTokens} tokens${facts.hasImages ? ", contains images" : ""}.\n` +
							(lastAssistantText(request.messages) ? `Last assistant reply (start): ${lastAssistantText(request.messages)}\n` : "") +
							`New user message:\n${text.slice(0, 3000)}`;
						const within = (ms: number) => AbortSignal.any([AbortSignal.timeout(ms), ...(request.signal ? [request.signal] : [])]);
						const d = auto.decisions;
						const key = process.env.PI_OPENAI_API_KEY;
						if (d && key) {
							try {
								const res = await fetch(`${(d.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/decisions`, {
									method: "POST",
									headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
									body: JSON.stringify(decisionsRequest(d.model, auto.tiers, prompt)),
									signal: within(d.timeoutMs ?? 4000),
								});
								if (res.ok) proposed = parseDecision(await res.json(), auto.tiers, d.minConfidence);
							} catch {
								// Decisions down or slow: ask the chat classifier instead
							}
						}
						if (!proposed && classifier && registry.hasConfiguredAuth(classifier) && !pressureOf(c)?.exhausted) {
							try {
								const res: any = await registry.complete(
									classifier,
									{ systemPrompt: AUTO_CLASSIFIER_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] } as any,
									{ maxTokens: 200, signal: within(c.timeoutMs ?? 8000) } as any,
								);
								proposed = parseTier((res?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" "), auto.tiers);
							} catch {
								// classifier down or slow: keep the current tier
							}
						}
					}
					const next = decideTier(tier, proposed?.tier, auto.tiers, auto.default, facts.estimatedTokens);
					if (next !== tier && tier) note = `auto: ${tier} → ${next}${proposed?.why ? ` (${proposed.why})` : ""}`;
					tier = next;
					autoWhy = proposed?.why;
				}
				tier ??= auto.default;
				const inner = request.state?.byTier?.[tier];
				const choice = chooseRoute({
					pressure: pressureOf,
					cfg,
					profile: models,
					virtualId: tier,
					reason: request.reason,
					previous: request.previous && { provider: request.previous.model.provider, id: request.previous.model.id },
					failed: request.failed && { provider: request.failed.model.provider, id: request.failed.model.id, errorMessage: request.failed.message.errorMessage },
					state: inner,
					...facts,
					now: Date.now(),
					lookup: (provider, model) => modelInfo(registry.find(provider, model)),
					hasAuth: (info) => {
						const m = registry.find(info.provider, info.id);
						return !!m && registry.hasConfiguredAuth(m);
					},
				});
				if (note || choice.note) say(ctx, [note, choice.note].filter(Boolean).join("; "), "info");
				noteRoute({ model: choice.target.model, thinking: choice.target.thinking, tier, why: autoWhy });
				const changed = tier !== request.state?.tier || choice.state !== undefined;
				return {
					model: registry.find(choice.target.provider, choice.target.model)!,
					thinkingLevel: choice.target.thinking,
					state: changed ? { tier, byTier: { ...(request.state?.byTier ?? {}), ...(choice.state ? { [tier]: choice.state } : {}) } } : undefined,
				};
			},
		});
	}

	registerAdvisor(pi, { cfg, models, profile, blocked, pressureOf });

	// --- request guard --------------------------------------------------------------

	// Supported hooks cannot veto a request by provider, so the Work allowlist is also enforced
	// at ModelRuntime.prepareRequest, which every chat, compaction, image and classifier request
	// passes. The method is not documented API: if it disappears, Work still has credential
	// isolation, the route and the model checks, and says so.
	const requestBlock = (model: { provider: string; id: string }): string | undefined => {
		const why = blocked();
		if (why) return why;
		if (models === "work" && cfg && !providerAllowed(cfg, "work", model.provider))
			return `pi-profile: the Work profile does not send requests to ${model.provider}/${model.id} (allowed: ${cfg.profiles.work.allowedProviders!.join(", ")}). If the enterprise seat is out of credits, restart deliberately on personal models: piw --personal-models -c`;
		return undefined;
	};

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
		return `${profile}${override ? " on PERSONAL models" : ""} · mem ${mem}${blocked() ? " · BLOCKED" : ""}`;
	};

	// Replaces Pi's footer (token counts, cost) with profile, place, memory, route and context.
	const OWN_STATUSES = new Set(["pi-profile", "pi-router"]);
	// The model behind the latest reply and the `auto` tier, from the session; cached per entry count.
	let answered: { key: string; route?: FooterState["route"] } = { key: "" };
	const answeredRoute = (sm: any): FooterState["route"] => {
		const key = `${sm.getSessionId?.()}:${sm.getLeafId?.()}:${sm.getEntryCount?.()}`;
		if (answered.key === key) return answered.route;
		let route: FooterState["route"];
		let tier: string | undefined;
		const branch: any[] = sm.getBranch?.() ?? sm.getEntries?.() ?? [];
		for (let i = branch.length - 1; i >= 0 && (!route || !tier); i--) {
			const e = branch[i];
			if (!route && e?.type === "message" && e.message?.role === "assistant" && e.message.model)
				route = { model: e.message.model, thinking: e.message.thinkingLevel };
			if (!tier && e?.type === "custom" && e.customType === "pi.virtual-model-state" && e.data?.modelId === "auto") tier = e.data.state?.tier;
		}
		if (route && tier) route.tier = tier;
		answered = { key, route };
		return route;
	};
	const withWhy = (r: FooterState["route"]) => (r && autoWhy && r.tier ? { ...r, why: autoWhy } : r);
	const showFooter = (ctx: any) => {
		if (!ctx?.hasUI) return;
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
					const virtual = !!m && m.provider === models && (m.id === "auto" || !!cfg?.profiles[models].models[m.id]);
					const usage = ctx.getContextUsage?.();
					const statuses = [...data.getExtensionStatuses().entries()]
						.filter(([k]: [string, string]) => !OWN_STATUSES.has(k))
						.sort(([a]: [string, string], [b]: [string, string]) => a.localeCompare(b))
						.map(([, v]: [string, string]) => String(v).replace(/\s+/g, " ").trim())
						.filter(Boolean);
					return renderFooter(
						{
							profile,
							override,
							blocked: !!blocked(),
							cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
							home: HOME,
							branch: data.getGitBranch() ?? undefined,
							sessionName: ctx.sessionManager.getSessionName?.() ?? undefined,
							memory: memState,
							model: m ? { provider: m.provider, id: m.id, virtual } : undefined,
							route: virtual ? (lastRoute ?? withWhy(answeredRoute(ctx.sessionManager))) : undefined,
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
		if (!guardInstalled && models === "work")
			say(ctx, "pi-profile: request guard unavailable in this Pi version; Work relies on credential isolation and model checks", "warning");
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
			sessionBlock = `pi-profile: this session was recorded under the ${stamp.data.profile} profile; it cannot continue under ${profile}. Use ${stamp.data.profile === "work" ? "piw" : "pi"} --session ${file ?? "<file>"}.`;
		} else if (!stamp && file && inside(canon(file), otherDir)) {
			sessionBlock = `pi-profile: ${file} belongs to the other profile's session store; not continuing it under ${profile}.`;
		}
		ctx.ui.setStatus("pi-profile", status());
		noteActive(ctx.model?.provider);
		showFooter(ctx);
		showBars(ctx);
		checkAlerts(ctx);
		const why = blocked();
		if (why) say(ctx, why, "error");
		else if (cfgError) say(ctx, cfgError, "error");
		else if (orgPolicyError) say(ctx, orgPolicyError, "warning");
		else if (personalPolicyMissing) say(ctx, personalPolicyMissing, "warning");
		else if (orgPolicy?.managedRulesOnly && models === "work")
			say(ctx, "pi-profile: your organisation's Claude policy only honours managed permission rules, so Claude Code will refuse Pi's tools in Work.", "warning");
		// The launcher already printed these on stderr; repeat them where the TUI can show them.
		else if (ctx.hasUI && override)
			ctx.ui.notify("Work session on PERSONAL models (--personal-models): personal subscriptions/LiteLLM are billed; sessions and memory stay Work.", "warning");
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

	// In the TUI a forbidden pick is undone on the spot. Without a UI (`pi -p --model …`) it is
	// left selected so the request guard fails the run loudly instead of answering with another model.
	pi.on("model_select", async (event, ctx) => {
		noteActive(event.model.provider);
		lastRoute = undefined;
		autoWhy = undefined;
		if (models !== "work" || !cfg || providerAllowed(cfg, "work", event.model.provider)) return;
		if (!ctx.hasUI) return;
		const back =
			event.previousModel && providerAllowed(cfg, "work", event.previousModel.provider)
				? event.previousModel
				: ctx.modelRegistry.find("work", "daily");
		ctx.ui.notify(
			`Work policy: ${event.model.provider}/${event.model.id} is not available in the Work profile${back ? `; staying on ${back.provider}/${back.id}` : ""}`,
			"error",
		);
		if (back) await pi.setModel(back);
	});

	pi.on("input", (event, ctx) => {
		const why =
			blocked() ??
			(models === "work" && cfg && ctx.model && !providerAllowed(cfg, "work", ctx.model.provider)
				? `Work policy: ${ctx.model.provider}/${ctx.model.id} is not available in the Work profile; pick work/daily with /model`
				: undefined);
		// Only the TUI can explain a swallowed prompt. Elsewhere the prompt proceeds and the route
		// or request guard fails it with the same reason and a non-zero exit.
		if (!why || !ctx.hasUI) return { action: "continue" as const };
		ctx.ui.notify(why, "error");
		return { action: "handled" as const };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const why = blocked() ?? memoryToolBlock(profile, event.toolName, input, { home: process.env.MEMINI_HOME, memoryOff });
		if (why) return { block: true, reason: why };
		// No AI attribution in commits, whichever model is answering. Edited in place so the
		// Work policy below judges the command that will actually run.
		if (event.toolName === "bash" && typeof input?.command === "string") {
			const fix = stripAiTrailers(input.command);
			if (fix?.leftover)
				return { block: true, reason: `Commits must not credit an AI model or agent. Remove "${fix.leftover}" from the commit message and commit again.` };
			if (fix) input.command = fix.command;
		}
		if (!orgPolicy) {
			if (personalPolicyMissing) return undefined;
			return /^memory_/.test(event.toolName) ? undefined : { block: true, reason: orgPolicyError! };
		}

		const d = decide(orgPolicy, event.toolName, input, { cwd: ctx.cwd, home: HOME, approvals });
		if (d.verdict === "allow") return undefined;
		if (d.verdict === "deny") return { block: true, reason: d.reason };
		if (!ctx.hasUI)
			return { block: true, reason: `${d.reason}; it needs your approval, which a headless run cannot ask for. Approve it "for this session" in the interactive session, or run it yourself.` };

		const isBash = event.toolName === "bash";
		const scope = isBash ? bashScope(String(input?.command ?? "")) : event.toolName;
		const session =
			isBash ? `Allow \`${scope}\` commands for this session`
			: event.toolName === "edit" || event.toolName === "write" ? "Allow file edits for this session"
			: `Allow ${event.toolName} for this session`;
		const detail = isBash ? String(input?.command ?? "") : JSON.stringify(input ?? {}).slice(0, 300);
		notify(`Pi · ${basename(ctx.cwd)}`, `${policyName}: approval needed`);
		const choice = await ctx.ui.select(`${policyName}: ${d.reason}\n\n${detail}`, ["Allow once", session, "Deny"]);
		if (choice === "Allow once") return undefined;
		if (choice === session) {
			if (isBash) approve("bash", scope);
			else if (event.toolName === "edit" || event.toolName === "write") (approve("tools", "edit"), approve("tools", "write"));
			else approve("tools", event.toolName);
			return undefined;
		}
		return { block: true, reason: `denied by you (${policyName} approval)` };
	});

	pi.on("tool_result", (event, ctx) => {
		if (!orgPolicy || !["grep", "find", "ls"].includes(event.toolName)) return undefined;
		let hidden = 0;
		const content = event.content.map((c) => {
			if (c.type !== "text") return c;
			const r = redactSearchOutput(orgPolicy!, event.toolName, event.input as Record<string, unknown>, c.text, ctx.cwd, HOME);
			hidden += r.hidden;
			return { ...c, text: r.text };
		});
		if (!hidden) return undefined;
		content.push({ type: "text", text: `[${hidden} result(s) hidden: ${orgPolicy!.label ?? "your organisation's Claude policy"} denies reading them]` });
		return { content };
	});

	// --- notifications ------------------------------------------------------------------------

	// A run that took long enough for you to look away ends with a terminal notification.
	let runStarted = 0;
	pi.on("agent_start", () => {
		if (!runStarted) runStarted = Date.now();
	});
	pi.on("agent_settled", (_event, ctx) => {
		const took = runStarted ? Date.now() - runStarted : 0;
		runStarted = 0;
		if (took >= notifyAfterMs()) notify(`Pi · ${basename(ctx.cwd)}`, `Done in ${duration(took)}, ready for input`);
	});

	// --- fallback for failures Pi does not retry ---------------------------------------------

	// Pi only re-routes (reason "retry") after transient errors. A plan limit, a missing login or
	// an unavailable model ends the turn instead, so when the virtual model has a usable next
	// target the error is restated as retryable; the router then moves down the chain. The
	// provider's own text is kept in a session entry and shown as a notice.
	pi.on("message_end", (event, ctx) => {
		const m = event.message as any;
		if (m?.role === "assistant") lastRoute = undefined;
		if (m?.role === "assistant" && cfg) {
			const pool = poolOf(cfg, { provider: m.provider });
			if (m.stopReason === "error" && classifyError(m.errorMessage) === "quota") markLimited(m.provider, m.errorMessage ?? "");
			else if (pool && pools.includes(pool) && (!usage[pool] || Date.now() - Date.parse(usage[pool].fetchedAt) > 120_000)) kickRefresh([pool]);
			if (m.stopReason !== "error") noteActive(m.provider);
			reloadUsage();
			ctx.ui.setStatus("pi-profile", status());
			checkAlerts(ctx);
		}
		if (!cfg || m?.role !== "assistant" || m.stopReason !== "error" || !m.errorMessage) return;
		if (ctx.model?.provider !== models || !cfg.profiles[models].models[ctx.model.id]) return;
		const cls = classifyError(m.errorMessage);
		if (cls !== "quota" && cls !== "auth" && cls !== "unavailable") return;
		if (m.errorMessage.startsWith("pi-profile fallback")) return;
		const registry = ctx.modelRegistry;
		const next = nextFallback({
			cfg,
			profile: models,
			virtualId: ctx.model.id,
			failed: { provider: m.provider, id: m.model, errorMessage: m.errorMessage },
			lookup: (provider, model) => modelInfo(registry.find(provider, model)),
			hasAuth: (info) => {
				const found = registry.find(info.provider, info.id);
				return !!found && registry.hasConfiguredAuth(found);
			},
		});
		if (!next) {
			const hint = failureHint(models, m.provider, cls);
			if (hint) say(ctx, `${m.provider}/${m.model}: ${hint}`, "error");
			return;
		}
		const from = `${m.provider}/${m.model}`;
		const to = `${next.provider}/${next.model}`;
		pi.appendEntry("pi-profile-fallback", { from, to, class: cls, error: m.errorMessage, at: new Date().toISOString() });
		say(ctx, `${ctx.model.id}: ${from} failed (${cls}): ${m.errorMessage.slice(0, 200)} — trying ${to}`, "warning");
		return { message: { ...m, errorMessage: fallbackMarker(cls, from, to) } };
	});

	// --- project trust ------------------------------------------------------------------------

	// Project settings, extensions and MCP servers load after trust; in Work they could add
	// providers or code paths around the policy, so such projects stay untrusted.
	pi.on("project_trust", (event, ctx) => {
		if (profile !== "work") return { trusted: "undecided" as const };
		const risks = workProjectRisks(event.cwd);
		if (!risks.length) return { trusted: "undecided" as const };
		say(ctx, `Work profile: not loading project config from ${event.cwd} (${risks.join(", ")})`, "warning");
		return { trusted: "no" as const };
	});

	// --- usage visibility ----------------------------------------------------------------------------

	const usageReport = (ctx: any): string => {
		reloadUsage();
		const now = Date.now();
		return [...pools.map((p) => (usage[p] ? describeUsage(usage[p], now, usageOpts) : `${p}: not fetched yet`)), ...routingLines(ctx, now)].join("\n");
	};

	const routingLines = (ctx: any, now: number): string[] => {
		const lines: string[] = [];
		if (cfg) {
			const registry = ctx.modelRegistry;
			for (const id of Object.keys(cfg.profiles[models].models)) {
				try {
					const c = chooseRoute({
						pressure: pressureOf,
						cfg,
						profile: models,
						virtualId: id,
						reason: "user",
						hasImages: false,
						estimatedTokens: 0,
						now,
						lookup: (provider, model) => modelInfo(registry.find(provider, model)),
						hasAuth: (info) => {
							const m = registry.find(info.provider, info.id);
							return !!m && registry.hasConfiguredAuth(m);
						},
					});
					lines.push(`${models}/${id} → ${c.target.provider}/${c.target.model}:${c.target.thinking}${c.note ? ` (${c.note.replace(/^[^:]+: using [^ ]+ \(/, "").replace(/\)$/, "")})` : ""}`);
				} catch (e) {
					lines.push(`${models}/${id} → none (${(e as Error).message})`);
				}
			}
		}
		return lines;
	};

	pi.registerTool({
		name: "usage_status",
		label: "Usage",
		description:
			"Show how much of each of the user's AI subscriptions (Claude, ChatGPT/Codex, OpenCode Go, MiniMax) is used and where each virtual model would route a new prompt right now. Use it before choosing a model, subagent or advisor for a large task.",
		promptSnippet: "usage_status: subscription usage left and current routing",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: usageReport(ctx) }], details: undefined };
		},
	});

	pi.registerCommand("usage", {
		description: "Show subscription usage and current routing (`/usage refresh` to re-read now)",
		handler: async (args, ctx) => {
			if (args.trim() === "refresh") {
				lastKick = 0;
				kickRefresh(pools);
				ctx.ui.notify("Refreshing usage in the background; run /usage again in a few seconds.", "info");
				return;
			}
			if (!ctx.hasUI || !pools.length) {
				ctx.ui.notify(usageReport(ctx), "info");
				return;
			}
			reloadUsage();
			await ctx.ui.custom<void>((_tui: unknown, theme: any, _kb: unknown, done: (r?: void) => void) => ({
				render: (width: number) => renderPanel(poolViews(), routingLines(ctx, Date.now()), Date.now(), usageOpts, theme, width),
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q" || data === " ") done();
				},
				invalidate() {},
			}));
		},
	});

	// --- diagnostics ----------------------------------------------------------------------------

	pi.registerCommand("profile", {
		description: "Show the Pi profile, memory scope and virtual-model chains",
		handler: async (_args, ctx) => {
			const lines = [
				`profile: ${profile}${override ? " — on PERSONAL models (--personal-models)" : ""}  (agent dir ${agentDir})`,
				`sessions: ${process.env.PI_CODING_AGENT_SESSION_DIR ?? `${agentDir}/sessions`}`,
				`claude config: ${process.env.CLAUDE_CONFIG_DIR ?? "(unset — bridge uses ~/.claude)"}`,
				`memini: ${memState}`,
				`namespace env: prefix=${process.env.MEMINI_NAMESPACE_PREFIX ?? "-"} namespace=${process.env.MEMINI_NAMESPACE ?? "-"} home=${process.env.MEMINI_HOME ?? "-"}`,
				blocked() ? `BLOCKED: ${blocked()}` : "requests: allowed",
				orgPolicy
					? `${profile === "work" ? "org" : "personal"} tool policy: ${orgPolicy.allow.length} allow, ${orgPolicy.deny.length} deny, ${orgPolicy.ask.length} ask rules${orgPolicy.unlisted === "allow" ? " (anything else runs)" : ""}; session approvals: ${JSON.stringify(approvals)}`
					: (orgPolicyError ?? personalPolicyMissing ?? "no tool policy"),
				...(cfgError ? [cfgError] : []),
				...Object.entries(cfg?.profiles[models].models ?? {}).map(
					([id, spec]) => `${models}/${id}: ${spec.chain.map((t) => `${t.provider}/${t.model}:${t.thinking}`).join(" → ")}${spec.fallback === false ? " (no fallback)" : ""}`,
				),
				`selected: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "-"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// Exported for tests.
export { expectedProfile, workProjectRisks };
