// Pure policy for the profile extension: routing-config validation, route
// selection, failure classification and memory-scope checks. No Pi runtime
// imports, so tests run it under plain `node --test`.

export type Profile = "personal" | "work";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Billing = string;

export interface Target {
	provider: string;
	model: string;
	thinking: Thinking;
	billing?: Billing;
	/** Skip on a new prompt once the subscription's busiest window is at least this full (default usage.defaultMaxUsed). */
	maxUsed?: number;
	/** Also skip while a window is burning faster than its time (used % ahead of elapsed % by more than usage.paceSlack). */
	paced?: boolean;
	/** Usage pool, when it differs from the provider's. */
	usage?: string;
}

export interface VirtualSpec {
	name: string;
	level: Thinking;
	chain: Target[];
	fallback?: boolean;
	/** Added to the error when a no-fallback model fails, e.g. what to use while a box is offline. */
	unavailableHint?: string;
}

/** A virtual model whose tier (one of `tiers`) a classifier model picks for each new prompt. */
export interface AutoSpec {
	name: string;
	tiers: string[];
	default: string;
	classifier: { provider: string; model: string; timeoutMs?: number };
	/**
	 * OpenAI Decisions API (`POST /v1/decisions`), asked first when its key (PI_OPENAI_API_KEY) is
	 * set; `classifier` stays the fallback. Personal only: it is billed to an OpenAI API account.
	 */
	decisions?: { model: string; baseUrl?: string; timeoutMs?: number; minConfidence?: number };
}

export interface ProviderSpec {
	billing: Billing;
	failsOverInternally?: boolean;
	/** Subscription usage pool (usage.ts / usage-sources.ts) its requests draw on. */
	usage?: string;
}

export interface UsagePolicy {
	refreshMinutes: number;
	staleMinutes: number;
	exhaustedPercent: number;
	defaultMaxUsed: number;
	paceSlack: number;
}

export const DEFAULT_USAGE: UsagePolicy = { refreshMinutes: 5, staleMinutes: 30, exhaustedPercent: 97, defaultMaxUsed: 90, paceSlack: 10 };

/** What the router needs to know about a target's usage pool; undefined means unknown. */
export interface TargetPressure {
	usedPct: number;
	aheadOfPace: number;
	exhausted: boolean;
	worst: string;
}

export interface ProfileSpec {
	allowedProviders: string[] | null;
	models: Record<string, VirtualSpec>;
	auto?: AutoSpec;
}

export interface AdvisorSpec {
	/** Default preference when the agent names no advisor. */
	order: string[];
	models: Record<string, Target>;
}

export interface RoutingConfig {
	providers: Record<string, ProviderSpec>;
	transientRetriesPerModel: number;
	stickyFallbackMinutes: number;
	profiles: Record<Profile, ProfileSpec>;
	advisors?: Partial<Record<Profile, AdvisorSpec>>;
	usage?: Partial<UsagePolicy>;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROFILES: Profile[] = ["personal", "work"];

/** Validate routing.json. Throws with every problem found, so a bad edit fails loudly at startup. */
export function loadRouting(raw: unknown): RoutingConfig {
	const errors: string[] = [];
	const cfg = raw as RoutingConfig;
	if (!cfg || typeof cfg !== "object") throw new Error("routing config is not an object");
	if (!cfg.providers || typeof cfg.providers !== "object") errors.push("providers missing");
	if (!Number.isInteger(cfg.transientRetriesPerModel) || cfg.transientRetriesPerModel < 0)
		errors.push("transientRetriesPerModel must be a non-negative integer");
	if (typeof cfg.stickyFallbackMinutes !== "number" || cfg.stickyFallbackMinutes < 0)
		errors.push("stickyFallbackMinutes must be a non-negative number");
	for (const profile of PROFILES) {
		const spec = cfg.profiles?.[profile];
		if (!spec) {
			errors.push(`profiles.${profile} missing`);
			continue;
		}
		const allowed = spec.allowedProviders;
		if (allowed !== null && !Array.isArray(allowed)) errors.push(`profiles.${profile}.allowedProviders must be null or a list`);
		if (profile === "work" && !Array.isArray(allowed)) errors.push("profiles.work.allowedProviders must list providers explicitly");
		if (!spec.models?.daily) errors.push(`profiles.${profile}.models.daily missing (startup default)`);
		for (const [id, v] of Object.entries(spec.models ?? {})) {
			const where = `profiles.${profile}.models.${id}`;
			if (!THINKING.has(v.level)) errors.push(`${where}.level invalid`);
			if (!Array.isArray(v.chain) || v.chain.length === 0) {
				errors.push(`${where}.chain must not be empty`);
				continue;
			}
			const billings = new Set<string>();
			for (const [i, t] of v.chain.entries()) {
				const at = `${where}.chain[${i}]`;
				if (!t.provider || !t.model) errors.push(`${at} needs provider and model`);
				if (!THINKING.has(t.thinking)) errors.push(`${at}.thinking invalid`);
				if (!cfg.providers?.[t.provider]) errors.push(`${at}: provider ${t.provider} not described in providers`);
				if (t.maxUsed !== undefined && !(typeof t.maxUsed === "number" && t.maxUsed > 0 && t.maxUsed <= 100)) errors.push(`${at}.maxUsed must be 1-100`);
				if (t.paced !== undefined && typeof t.paced !== "boolean") errors.push(`${at}.paced must be true or false`);
				if (Array.isArray(allowed) && !allowed.includes(t.provider))
					errors.push(`${at}: provider ${t.provider} not allowed in ${profile}`);
				billings.add(billingOf(cfg, t));
			}
			if (billings.size > 1) errors.push(`${where}.chain mixes billing classes (${[...billings].join(", ")})`);
		}
		const auto = spec.auto;
		if (auto) {
			const where = `profiles.${profile}.auto`;
			if (spec.models?.auto) errors.push(`${where}: a virtual model is already called auto`);
			if (!Array.isArray(auto.tiers) || !auto.tiers.length) errors.push(`${where}.tiers must list virtual models`);
			for (const t of auto.tiers ?? []) if (!spec.models?.[t]) errors.push(`${where}.tiers: unknown virtual model ${t}`);
			if (!auto.tiers?.includes(auto.default)) errors.push(`${where}.default must be one of the tiers`);
			const c = auto.classifier;
			if (!c?.provider || !c?.model) errors.push(`${where}.classifier needs provider and model`);
			else if (Array.isArray(allowed) && !allowed.includes(c.provider)) errors.push(`${where}.classifier: provider ${c.provider} not allowed in ${profile}`);
			if (auto.decisions) {
				if (profile === "work") errors.push(`${where}.decisions is not allowed in work (it bills a personal OpenAI API account)`);
				if (!auto.decisions.model) errors.push(`${where}.decisions needs a model`);
			}
		}
	}
	for (const [profile, spec] of Object.entries(cfg.advisors ?? {}) as [Profile, AdvisorSpec][]) {
		const where = `advisors.${profile}`;
		if (!PROFILES.includes(profile)) errors.push(`${where}: unknown profile`);
		const names = Object.keys(spec?.models ?? {});
		if (!names.length) errors.push(`${where}.models must not be empty`);
		for (const name of spec?.order ?? []) if (!names.includes(name)) errors.push(`${where}.order names unknown advisor ${name}`);
		for (const [name, t] of Object.entries(spec?.models ?? {})) {
			if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`${where}.models.${name}: names are lowercase words`);
			if (!t.provider || !t.model || !THINKING.has(t.thinking)) errors.push(`${where}.models.${name} needs provider, model and a valid thinking level`);
			const allowed = cfg.profiles?.[profile]?.allowedProviders;
			if (Array.isArray(allowed) && !allowed.includes(t.provider)) errors.push(`${where}.models.${name}: provider ${t.provider} not allowed in ${profile}`);
		}
	}
	if (errors.length) throw new Error(errors.join("; "));
	return cfg;
}

export function usagePolicy(cfg: Pick<RoutingConfig, "usage">): UsagePolicy {
	return { ...DEFAULT_USAGE, ...(cfg.usage ?? {}) };
}

/** The usage pool a target draws on, if tracked. */
export function poolOf(cfg: Pick<RoutingConfig, "providers">, t: { provider: string; usage?: string }): string | undefined {
	return t.usage ?? cfg.providers[t.provider]?.usage;
}

export function billingOf(cfg: Pick<RoutingConfig, "providers">, t: Target): Billing {
	return t.billing ?? cfg.providers[t.provider]?.billing ?? "unknown";
}

/** Whether `profile` may send a request to `provider`. Virtual models live under the profile's own id. */
export function providerAllowed(cfg: RoutingConfig, profile: Profile, provider: string): boolean {
	if (provider === profile) return true;
	const allowed = cfg.profiles[profile].allowedProviders;
	return allowed === null || allowed.includes(provider);
}

// --- failures ------------------------------------------------------------------

export type FailureClass = "overflow" | "quota" | "unavailable" | "auth" | "transient" | "other";

const FALLBACK_MARKER = /^pi-profile fallback \[(quota|unavailable|auth)\]/;

const PATTERNS: [FailureClass, RegExp][] = [
	["overflow", /context.?(length|window)|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long|exceeds the model'?s? (maximum|context)/i],
	// Subscription and gateway limits that reset in hours, not seconds. pi-claude-bridge relabels
	// Claude Code's plan limits as "Claude rate limit (<type>) — resets …".
	["quota", /usage.?limit|quota|insufficient_quota|billing|out of budget|credit balance|limit reached|Claude rate limit \(|subscription_sharing|GoUsageLimitError|FreeUsageLimitError|available balance/i],
	["unavailable", /model[^.]{0,60}(not found|not available|isn't available|does not exist|not supported|unsupported|no access|not allowed|not enabled)|not_found_error|model_not_found|unknown model|invalid model|no such model|does not have access to (the )?model|\b404\b/i],
	["auth", /not logged in|please run \/login|\/login|unauthori[sz]ed|\b401\b|authentication_error|invalid (api.?key|x-api-key|bearer|token)|oauth token|token (has )?expired|no credentials|not configured|permission_error|forbidden|\b403\b/i],
	["transient", /overloaded|high demand|at capacity|rate.?limit|too many requests|\b429\b|\b50[0234]\b|\b52[04]\b|service.?unavailable|server.?error|internal.?error|network|connection|socket|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|timed? ?out|terminated|ended without|stream ended/i],
];

export function classifyError(text: string | undefined): FailureClass {
	if (!text) return "other";
	const marked = FALLBACK_MARKER.exec(text);
	if (marked) return marked[1] as FailureClass;
	for (const [cls, re] of PATTERNS) if (re.test(text)) return cls;
	return "other";
}

/**
 * Text that replaces a non-retryable failure when a fallback exists. Pi retries errors that match
 * its transient patterns ("service unavailable"); quota/billing wording would stop it, so the
 * original text is kept in a session entry instead of here.
 */
export function fallbackMarker(cls: FailureClass, from: string, to: string): string {
	return `pi-profile fallback [${cls}]: ${from} service unavailable for this request; retrying on ${to}. The provider's original error is saved in the session (pi-profile-fallback entry).`;
}

// --- routing -------------------------------------------------------------------

export interface ModelInfo {
	provider: string;
	id: string;
	input: string[];
	contextWindow: number;
}

export interface RouterState {
	/** Chain index later prompts start from until `until` (epoch ms). */
	sticky?: { index: number; until: number };
	/** Transient failures per target key during the current prompt. */
	fails?: Record<string, number>;
}

export interface RouteInput {
	cfg: RoutingConfig;
	profile: Profile;
	virtualId: string;
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: { provider: string; id: string };
	failed?: { provider: string; id: string; errorMessage?: string };
	state?: RouterState;
	hasImages: boolean;
	estimatedTokens: number;
	now: number;
	lookup(provider: string, id: string): ModelInfo | undefined;
	hasAuth(info: ModelInfo): boolean;
	/** Usage pressure of a target's subscription; undefined when unknown or untracked. */
	pressure?(t: Target): TargetPressure | undefined;
}

export interface RouteChoice {
	index: number;
	target: Target;
	/** New router state, or undefined to keep the current one. */
	state?: RouterState;
	note?: string;
}

export class RouteError extends Error {}

const key = (t: { provider: string; model?: string; id?: string }) => `${t.provider}/${t.model ?? t.id}`;
const sameTarget = (t: Target, m: { provider: string; id: string }) => t.provider === m.provider && t.model === m.id;

type Rejection = { index: number; why: string };

function usable(input: RouteInput, t: Target, checkFit: boolean): string | undefined {
	if (!providerAllowed(input.cfg, input.profile, t.provider)) return `${input.profile} policy forbids ${t.provider}`;
	const p = input.pressure?.(t);
	if (p?.exhausted) return `usage exhausted: ${p.worst}`;
	const info = input.lookup(t.provider, t.model);
	if (!info) return "not in the model catalog (extension not loaded?)";
	if (!input.hasAuth(info)) return "no credentials";
	if (input.hasImages && !info.input.includes("image")) return "no image input";
	if (checkFit && info.contextWindow > 0 && input.estimatedTokens > info.contextWindow * 0.9)
		return `context too large (${input.estimatedTokens} est. tokens, window ${info.contextWindow})`;
	return undefined;
}

function describe(spec: VirtualSpec, rejected: Rejection[]): string {
	return rejected.map((r) => `${key(spec.chain[r.index])}: ${r.why}`).join("; ");
}

/** Pick the physical target for one request. Deterministic; no model calls. */
export function chooseRoute(input: RouteInput): RouteChoice {
	const { cfg, profile, virtualId } = input;
	const spec = cfg.profiles[profile].models[virtualId];
	if (!spec) throw new RouteError(`pi-profile: ${profile}/${virtualId} is not configured`);
	const label = `${profile}/${virtualId}`;
	const chain = spec.chain;

	// Tool follow-ups, compaction and summaries stay on the model that answered last, which keeps
	// the prompt cache and thinking signatures valid through a tool loop.
	if ((input.reason === "continuation" || input.reason === "direct") && input.previous) {
		const index = chain.findIndex((t) => sameTarget(t, input.previous!));
		if (index >= 0 && !usable(input, chain[index], false)) return { index, target: chain[index] };
	}

	if (input.reason === "retry" && input.failed) {
		const failedIndex = chain.findIndex((t) => sameTarget(t, input.failed!));
		if (failedIndex >= 0) return retryRoute(input, spec, label, failedIndex);
	}

	// A new prompt: the first target in chain order that is usable and inside its usage budget
	// (maxUsed, pace), starting from a sticky fallback while it lasts. Hysteresis keeps the router
	// from flapping at a threshold: the model that answered last keeps its place until it is 5
	// points over, and a target ranked above it has to be 5 points under before it takes over.
	const active = input.state?.sticky && input.state.sticky.until > input.now ? input.state.sticky : undefined;
	const reset = input.state?.fails !== undefined || (input.state?.sticky !== undefined && !active);
	const state: RouterState | undefined = reset ? (active ? { sticky: active } : {}) : undefined;
	const start = active?.index ?? 0;
	const order = [...chain.keys()].filter((i) => i >= start).concat([...chain.keys()].filter((i) => i < start));
	const prevIndex = input.previous ? chain.findIndex((t) => sameTarget(t, input.previous!)) : -1;
	const policy = usagePolicy(cfg);
	const overBudget = (index: number): string | undefined => {
		const t = chain[index];
		const p = input.pressure?.(t);
		if (!p) return undefined;
		const margin = index === prevIndex ? 5 : prevIndex >= 0 && index < prevIndex ? -5 : 0;
		const max = t.maxUsed ?? policy.defaultMaxUsed;
		if (p.usedPct >= max + margin) return `${p.worst} is over its ${max}% budget`;
		if (t.paced && p.aheadOfPace > policy.paceSlack + margin) return `${p.worst} is ${Math.round(p.aheadOfPace)} points ahead of pace`;
		return undefined;
	};
	const rejected: Rejection[] = [];
	const withinBudget: number[] = [];
	const overButUsable: number[] = [];
	for (const index of order) {
		const why = usable(input, chain[index], false);
		if (why) {
			rejected.push({ index, why });
			continue;
		}
		const budget = overBudget(index);
		if (budget) {
			rejected.push({ index, why: budget });
			overButUsable.push(index);
		} else withinBudget.push(index);
	}
	// Budgets steer, they never block: with every target over budget, take the first usable one.
	const index = withinBudget[0] ?? overButUsable[0];
	if (index !== undefined) {
		const skipped = rejected.filter((r) => r.index < index || order.indexOf(r.index) < order.indexOf(index));
		const note =
			index !== prevIndex && skipped.length
				? `${label}: using ${key(chain[index])} (${skipped.map((r) => `${key(chain[r.index])}: ${r.why}`).join("; ")})`
				: undefined;
		return { index, target: chain[index], state, note };
	}
	if (input.hasImages && rejected.every((r) => r.why === "no image input"))
		throw new RouteError(`pi-profile: ${label} has no model that accepts images; switch to another model (/model) rather than dropping them`);
	throw new RouteError(`pi-profile: no usable model for ${label} (${describe(spec, rejected)})${remedy(profile, rejected, chain)}`);
}

function retryRoute(input: RouteInput, spec: VirtualSpec, label: string, failedIndex: number): RouteChoice {
	const { cfg } = input;
	const chain = spec.chain;
	const failedTarget = chain[failedIndex];
	const cls = classifyError(input.failed!.errorMessage);
	const provider = cfg.providers[failedTarget.provider];

	// Pi compacted before this retry; the route stays put (and `local` never leaves the box).
	if (cls === "overflow") return { index: failedIndex, target: failedTarget };

	const fails = { ...(input.state?.fails ?? {}) };
	if (cls === "transient" && !provider?.failsOverInternally) {
		const k = key(failedTarget);
		fails[k] = (fails[k] ?? 0) + 1;
		if (fails[k] <= cfg.transientRetriesPerModel)
			return { index: failedIndex, target: failedTarget, state: { ...input.state, fails } };
	}

	if (spec.fallback === false)
		throw new RouteError(`pi-profile: ${label} does not fall back (${key(failedTarget)} failed: ${cls})${spec.unavailableHint ? `. ${spec.unavailableHint}` : "; retry later or switch model"}`);

	// Plan limits and missing logins apply to every model of the provider; a gateway that fails
	// over internally has already tried its own alternatives.
	const skipProvider = cls === "quota" || cls === "auth" || provider?.failsOverInternally ? failedTarget.provider : undefined;
	const billing = billingOf(cfg, failedTarget);
	const rejected: Rejection[] = [];
	for (let index = failedIndex + 1; index < chain.length; index++) {
		const t = chain[index];
		const why =
			t.provider === skipProvider ? `skipped after ${cls} on ${t.provider}`
			: billingOf(cfg, t) !== billing ? `different billing (${billingOf(cfg, t)})`
			: usable(input, t, true);
		if (why) {
			rejected.push({ index, why });
			continue;
		}
		const minutes = cfg.stickyFallbackMinutes;
		return {
			index,
			target: t,
			state: { sticky: minutes > 0 ? { index, until: input.now + minutes * 60_000 } : undefined, fails },
			note: `${label}: ${key(failedTarget)} failed (${cls}); using ${key(t)}`,
		};
	}
	throw new RouteError(
		`pi-profile: no fallback left for ${label} after ${key(failedTarget)} failed (${cls})` +
			(rejected.length ? `; ${describe(spec, rejected)}` : "") +
			remedy(input.profile, [{ index: failedIndex, why: cls }], chain),
	);
}

function remedy(profile: Profile, rejected: Rejection[], chain: Target[]): string {
	const providers = new Set(rejected.filter((r) => /credentials|auth/.test(r.why)).map((r) => chain[r.index].provider));
	const hints: string[] = [];
	if (providers.has("claude-bridge")) hints.push(`run \`pi-profile${profile === "work" ? " --work" : ""} login\``);
	if (providers.has("openai")) hints.push("run /login openai (Sign in with ChatGPT)");
	if (providers.has("litellm") || providers.has("opencode-go") || providers.has("minimax")) hints.push("run ai-sync, then restart pi");
	// Work never falls back to personal models by itself; the override is a deliberate restart.
	if (profile === "work" && rejected.some((r) => r.why === "quota" || r.why.startsWith("usage exhausted")))
		hints.push("if the enterprise seat is out of usage, continue this session on personal models with `piw --personal-models -c`");
	return hints.length ? `. To fix: ${hints.join("; ")}` : "";
}

/** What to tell the user when a login or plan limit has no fallback left. */
export function failureHint(models: Profile, provider: string, cls: FailureClass): string | undefined {
	if (cls === "auth" && provider === "claude-bridge") return `log this profile's Claude account in once: pi-profile${models === "work" ? " --work" : ""} login`;
	if (cls === "auth" && provider === "openai") return "log in once with /login openai (Sign in with ChatGPT)";
	if (cls === "auth" && ["litellm", "opencode-go", "minimax"].includes(provider)) return "run ai-sync, then restart pi";
	if (cls === "quota" && models === "work")
		return "the enterprise seat is out of usage; to continue this session on personal models, quit and run `piw --personal-models -c`";
	return undefined;
}

/** The next chain target a fallback would use, for message_end's decision to trigger a retry. */
export function nextFallback(
	input: Omit<RouteInput, "reason" | "previous" | "state" | "hasImages" | "estimatedTokens" | "now"> & { failed: { provider: string; id: string; errorMessage?: string } },
): Target | undefined {
	const spec = input.cfg.profiles[input.profile].models[input.virtualId];
	if (!spec || spec.fallback === false) return undefined;
	const failedIndex = spec.chain.findIndex((t) => sameTarget(t, input.failed));
	if (failedIndex < 0) return undefined;
	const failedTarget = spec.chain[failedIndex];
	const cls = classifyError(input.failed.errorMessage);
	const skip = cls === "quota" || cls === "auth" || input.cfg.providers[failedTarget.provider]?.failsOverInternally;
	const probe: RouteInput = { ...input, reason: "retry", hasImages: false, estimatedTokens: 0, now: 0 };
	return spec.chain.slice(failedIndex + 1).find(
		(t) =>
			!(skip && t.provider === failedTarget.provider) &&
			billingOf(input.cfg, t) === billingOf(input.cfg, failedTarget) &&
			!usable(probe, t, false),
	);
}

// --- conversation facts ----------------------------------------------------------

type Block = { type?: string; text?: string; thinking?: string; data?: string; arguments?: unknown };
type Msg = { role?: string; content?: string | Block[] };

export function conversationFacts(messages: readonly unknown[]): { hasImages: boolean; estimatedTokens: number } {
	let chars = 0;
	let images = 0;
	for (const raw of messages) {
		const m = raw as Msg;
		if (typeof m.content === "string") {
			chars += m.content.length;
			continue;
		}
		for (const b of m.content ?? []) {
			if (b.type === "image") images++;
			else if (typeof b.text === "string") chars += b.text.length;
			else if (typeof b.thinking === "string") chars += b.thinking.length;
			else if (b.arguments) chars += JSON.stringify(b.arguments).length;
		}
	}
	return { hasImages: images > 0, estimatedTokens: Math.ceil(chars / 4) + images * 1600 };
}

// --- memory scope ------------------------------------------------------------------

const MEMORY_WRITES = new Set(["memory_remember", "memory_update", "memory_forget"]);
const isWorkNs = (ns: string) => ns === "work" || ns.startsWith("work/");

/**
 * Block reason for a pi-memini tool call, or undefined to allow it. Work reads and writes stay in
 * work/*, apart from reading the personal home overlay; Personal never touches work/*. pi-memini's
 * `visibility: "personal"` writes into the home namespace, so Work may not use it.
 */
export function memoryToolBlock(
	profile: Profile,
	tool: string,
	args: Record<string, unknown> | undefined,
	opts: { home?: string; memoryOff?: string },
): string | undefined {
	if (!tool.startsWith("memory_")) return undefined;
	if (opts.memoryOff) return `memory is off for this session (${opts.memoryOff})`;
	const ns = typeof args?.namespace === "string" ? args.namespace.trim() : "";
	const visibility = typeof args?.visibility === "string" ? args.visibility.trim() : "";
	if (profile === "work") {
		if (ns && !isWorkNs(ns)) {
			if (MEMORY_WRITES.has(tool) || ns !== opts.home)
				return `Work sessions may only ${MEMORY_WRITES.has(tool) ? "write" : "read"} work/* memory${MEMORY_WRITES.has(tool) ? "" : " and the personal home overlay"} (got ${ns})`;
		}
		if (visibility && visibility !== "project" && !isWorkNs(visibility))
			return `Work memories stay in work/* (visibility ${visibility} is not allowed)`;
	} else {
		if (ns && isWorkNs(ns)) return `Personal sessions cannot access Work memory (${ns})`;
		if (visibility && isWorkNs(visibility)) return `Personal sessions cannot write Work memory (${visibility})`;
	}
	return undefined;
}

// --- auto (classifier-picked tier) ----------------------------------------------------------------

/** What each tier is for; shared by the chat classifier's prompt and the Decisions choices. */
export const TIER_GUIDE: Record<string, string> = {
	fast: "trivial or mechanical work: quick answers and lookups, renames, formatting, simple shell or git, small single-file edits with a clear spec.",
	daily: "normal engineering: implementing features, debugging with clear symptoms, refactors across a few files, writing tests, code review.",
	deep: "genuinely hard work: architecture or design decisions, subtle or intermittent bugs, concurrency, security, performance analysis, large cross-cutting changes, or a problem earlier attempts failed to fix.",
};

const TIER_JUDGING = `Judge how hard the thinking and the work are, not how long the requested answer is: a one-line answer to a hard diagnostic or design question is still deep, and a long but mechanical edit is fast.`;

export const AUTO_CLASSIFIER_PROMPT = `You route a coding agent's next turn to a model tier. Reply with JSON only: {"tier":"<tier>","why":"<at most 8 words>"}.
Tiers:
${Object.entries(TIER_GUIDE).map(([t, d]) => `- ${t}: ${d}`).join("\n")}
${TIER_JUDGING}
Short follow-ups ("yes", "go on", "do it", "thanks") keep the current tier. When unsure between two tiers, pick the stronger one.`;

/** Body of a Decisions API request asking which tier the turn needs (one `choice` question). */
export function decisionsRequest(model: string, tiers: string[], input: string): object {
	return {
		model,
		input,
		questions: [
			{
				type: "choice",
				name: "tier",
				instructions: `Which model tier should handle the coding agent's next turn, given the new user message and the conversation so far? ${TIER_JUDGING}`,
				choices: tiers.map((t) => ({ value: t, description: TIER_GUIDE[t] ?? `the ${t} tier` })),
			},
		],
	};
}

/**
 * The tier from a Decisions answer. When the model is unsure (confidence below `minConfidence`)
 * the stronger of the two likeliest tiers wins, as the chat classifier is told to do. Undefined
 * for a refusal or an answer outside `tiers`.
 */
export function parseDecision(body: any, tiers: string[], minConfidence = 0.5): { tier: string; why: string } | undefined {
	const a = (body?.answers ?? []).find((x: any) => x?.name === "tier");
	if (a?.type !== "choice" || !tiers.includes(a.choice)) return undefined;
	const probs: { value: string; probability: number }[] = (a.probabilities ?? []).filter((p: any) => tiers.includes(p?.value) && typeof p.probability === "number");
	const p = (tier: string) => probs.find((x) => x.value === tier)?.probability;
	const pct = (n: number | undefined) => (n === undefined ? "" : `${Math.round(n * 100)}%`);
	if (typeof a.confidence === "number" && a.confidence < minConfidence) {
		const [first, second] = [...probs].sort((x, y) => y.probability - x.probability);
		if (first && second) {
			const tier = tiers.indexOf(second.value) > tiers.indexOf(first.value) ? second.value : first.value;
			return { tier, why: `unsure ${first.value} ${pct(first.probability)} / ${second.value} ${pct(second.probability)}` };
		}
	}
	return { tier: a.choice, why: pct(p(a.choice) ?? a.confidence) };
}

/** Prompts too small to be worth a classifier call: they continue the current tier. */
export function isShortFollowUp(text: string): boolean {
	const t = text.trim();
	return t.length < 24 && t.split(/\s+/).length <= 4 && !/[?]/.test(t);
}

/** The tier named in the classifier's answer, if it is one of `tiers`. */
export function parseTier(answer: string, tiers: string[]): { tier: string; why: string } | undefined {
	try {
		const j = JSON.parse(/\{[\s\S]*\}/.exec(answer)?.[0] ?? "");
		if (tiers.includes(String(j.tier).toLowerCase())) return { tier: String(j.tier).toLowerCase(), why: String(j.why ?? "").slice(0, 80) };
	} catch {
		// fall through to a bare word
	}
	const word = tiers.find((t) => new RegExp(`\\b${t}\\b`, "i").test(answer));
	return word ? { tier: word, why: "" } : undefined;
}

/**
 * Apply the classifier's pick with hysteresis: in a long conversation a downgrade would throw
 * away the prompt cache for a small saving, so the current tier stays; upgrades always apply.
 */
export function decideTier(current: string | undefined, proposed: string | undefined, tiers: string[], fallback: string, estimatedTokens: number): string {
	const base = current && tiers.includes(current) ? current : fallback;
	if (!proposed || !tiers.includes(proposed)) return base;
	const downgrade = tiers.indexOf(proposed) < tiers.indexOf(base);
	return downgrade && estimatedTokens > 30_000 ? base : proposed;
}
