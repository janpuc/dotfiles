// Unit tests for home/dot_pi/shared/extensions/profile/policy.ts against the real routing.json.
// Run with tests/pi/run.sh (plain `node --test`; Node strips the TypeScript types).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	chooseRoute,
	classifyError,
	conversationFacts,
	decideTier,
	decisionsRequest,
	failureHint,
	fallbackMarker,
	isShortFollowUp,
	loadRouting,
	memoryToolBlock,
	nextFallback,
	parseDecision,
	parseTier,
	RouteError,
	type ModelInfo,
	type RouteInput,
	type RoutingConfig,
	type Target,
	type TargetPressure,
} from "../../home/dot_pi/shared/extensions/profile/policy.ts";

const raw = JSON.parse(readFileSync(new URL("../../home/dot_pi/shared/routing.json", import.meta.url), "utf8"));
const cfg = loadRouting(raw);
const clone = (): RoutingConfig => JSON.parse(JSON.stringify(raw));

const img = ["text", "image"];
const CATALOG: ModelInfo[] = [
	{ provider: "claude-bridge", id: "claude-opus-5-5", input: img, contextWindow: 1_000_000 },
	{ provider: "claude-bridge", id: "claude-sonnet-5-5", input: img, contextWindow: 1_000_000 },
	{ provider: "claude-bridge", id: "claude-haiku-4-5", input: img, contextWindow: 200_000 },
	{ provider: "claude-bridge", id: "claude-fable-5-1", input: img, contextWindow: 1_000_000 },
	{ provider: "openai", id: "gpt-6.1-sol", input: img, contextWindow: 272_000 },
	{ provider: "openai", id: "gpt-6-astra", input: img, contextWindow: 272_000 },
	{ provider: "openai", id: "gpt-6-luna", input: img, contextWindow: 272_000 },
	{ provider: "opencode-go", id: "glm-5.3", input: ["text"], contextWindow: 1_000_000 },
	{ provider: "opencode-go", id: "qwen3.8-max", input: img, contextWindow: 1_000_000 },
	{ provider: "opencode-go", id: "deepseek-v4.1-flash", input: img, contextWindow: 1_000_000 },
	{ provider: "minimax", id: "MiniMax-M3", input: img, contextWindow: 1_000_000 },
	{ provider: "litellm", id: "bc250/qwen3.6-35b-a3b", input: ["text"], contextWindow: 24_576 },
	{ provider: "litellm", id: "bc250-local/qwen3.6-35b-a3b", input: ["text"], contextWindow: 24_576 },
	{ provider: "amazon-bedrock", id: "anthropic.claude-opus-5-5", input: img, contextWindow: 1_000_000 },
];

type PoolState = Record<string, Partial<TargetPressure>>;
function input(over: Partial<RouteInput> & Pick<RouteInput, "profile" | "virtualId">, noAuth: string[] = [], pools: PoolState = {}): RouteInput {
	return {
		cfg,
		reason: "user",
		hasImages: false,
		estimatedTokens: 1000,
		now: 1_000_000,
		lookup: (p, id) => CATALOG.find((m) => m.provider === p && m.id === id),
		hasAuth: (m) => !noAuth.includes(m.provider),
		pressure: (t: Target) => {
			const pool = (over.cfg ?? cfg).providers[t.provider]?.usage;
			const p = pool ? pools[pool] : undefined;
			return p ? { usedPct: 0, aheadOfPace: 0, exhausted: false, worst: `${pool} ${p.usedPct ?? 0}%`, ...p } : undefined;
		},
		...over,
	};
}
const pick = (i: RouteInput) => {
	const r = chooseRoute(i);
	return `${r.target.provider}/${r.target.model}:${r.target.thinking}`;
};

// --- configuration -------------------------------------------------------------------------------

test("routing.json validates and keeps Work on the enterprise bridge", () => {
	assert.deepEqual(cfg.profiles.work.allowedProviders, ["claude-bridge"]);
	for (const spec of Object.values(cfg.profiles.work.models)) for (const t of spec.chain) assert.equal(t.provider, "claude-bridge");
	assert.equal(cfg.profiles.work.auto, undefined, "no MiniMax router in Work");
	assert.deepEqual(cfg.profiles.personal.auto?.tiers, ["fast", "daily", "deep"]);
	for (const spec of Object.values(cfg.profiles.personal.models)) for (const t of spec.chain) assert.notEqual(t.provider, "openai-codex", "legacy provider");
});

test("loadRouting rejects configs that would weaken Work or mix billing", () => {
	const permissive = clone();
	permissive.profiles.work.allowedProviders = null;
	assert.throws(() => loadRouting(permissive), /must list providers explicitly/);
	const leaky = clone();
	leaky.profiles.work.models.fast.chain.push({ provider: "minimax", model: "MiniMax-M3", thinking: "low" });
	assert.throws(() => loadRouting(leaky), /not allowed in work/);
	const mixed = clone();
	mixed.profiles.personal.models.daily.chain.push({ provider: "litellm", model: "bc250/qwen3.6-35b-a3b", thinking: "low" });
	assert.throws(() => loadRouting(mixed), /mixes billing/);
	const routerInWork = clone();
	routerInWork.profiles.work.auto = { name: "Auto", tiers: ["daily"], default: "daily", classifier: { provider: "minimax", model: "MiniMax-M3" } };
	assert.throws(() => loadRouting(routerInWork), /classifier: provider minimax not allowed in work/);
	const decisionsInWork = clone();
	decisionsInWork.profiles.work.auto = { name: "Auto", tiers: ["daily"], default: "daily", classifier: { provider: "claude-bridge", model: "claude-haiku-4-5" }, decisions: { model: "gpt-6-luna" } };
	assert.throws(() => loadRouting(decisionsInWork), /decisions is not allowed in work/);
	const badBudget = clone();
	badBudget.profiles.personal.models.daily.chain[0].maxUsed = 140;
	assert.throws(() => loadRouting(badBudget), /maxUsed must be 1-100/);
});

test("advisors are configured per profile and Work advisors stay on the enterprise seat", () => {
	assert.deepEqual(cfg.advisors?.personal?.order, ["astra", "fable"]);
	assert.deepEqual(Object.keys(cfg.advisors?.work?.models ?? {}), ["fable"]);
	const leaky = clone();
	leaky.advisors!.work!.models.astra = { provider: "openai", model: "gpt-6-astra", thinking: "high" };
	assert.throws(() => loadRouting(leaky), /advisors.work.models.astra: provider openai not allowed in work/);
});

// --- selection -----------------------------------------------------------------------------------

test("with usage unknown each tier starts at its primary, effort set per target", () => {
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" })), "claude-bridge/claude-opus-5-5:medium");
	assert.equal(pick(input({ profile: "personal", virtualId: "deep" })), "claude-bridge/claude-opus-5-5:high");
	assert.equal(pick(input({ profile: "personal", virtualId: "fast" })), "minimax/MiniMax-M3:low");
	assert.equal(pick(input({ profile: "personal", virtualId: "qwen" })), "litellm/bc250/qwen3.6-35b-a3b:medium");
	assert.equal(pick(input({ profile: "work", virtualId: "daily" })), "claude-bridge/claude-sonnet-5-5:medium");
	assert.equal(pick(input({ profile: "work", virtualId: "deep" })), "claude-bridge/claude-opus-5-5:high");
	assert.equal(pick(input({ profile: "work", virtualId: "fast" })), "claude-bridge/claude-haiku-4-5:off");
});

test("daily keeps Opus while the Claude week is on pace, then Sonnet, then other pools", () => {
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" }, [], { claude: { usedPct: 60, aheadOfPace: 5 } })), "claude-bridge/claude-opus-5-5:medium");
	const ahead = chooseRoute(input({ profile: "personal", virtualId: "daily" }, [], { claude: { usedPct: 71, aheadOfPace: 20 } }));
	assert.equal(ahead.target.model, "claude-sonnet-5-5");
	assert.match(ahead.note!, /ahead of pace/);
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" }, [], { claude: { usedPct: 92 } })), "openai/gpt-6.1-sol:medium");
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" }, [], { claude: { usedPct: 92 }, chatgpt: { usedPct: 96 } })), "opencode-go/glm-5.3:high");
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" }, [], { claude: { usedPct: 92 }, chatgpt: { usedPct: 96 }, "opencode-go": { usedPct: 85 } })), "minimax/MiniMax-M3:medium");
});

test("exhausted pools are skipped outright; soft budgets steer but never block", () => {
	assert.equal(pick(input({ profile: "personal", virtualId: "deep" }, [], { claude: { exhausted: true, usedPct: 100 } })), "openai/gpt-6.1-sol:xhigh");
	const allBusy = { claude: { usedPct: 95 }, chatgpt: { usedPct: 95 }, "opencode-go": { usedPct: 95 }, minimax: { usedPct: 95 } };
	assert.equal(pick(input({ profile: "personal", virtualId: "daily" }, [], allBusy)), "claude-bridge/claude-opus-5-5:medium", "over budget everywhere: the first usable one");
	assert.throws(
		() => chooseRoute(input({ profile: "work", virtualId: "daily" }, [], { claude: { exhausted: true, usedPct: 100, worst: "spend 100%" } })),
		(e: Error) => /usage exhausted: spend 100%/.test(e.message) && /piw --personal-models -c/.test(e.message),
	);
});

test("hysteresis: the last model keeps its place near a threshold and is not pre-empted early", () => {
	const previous = { provider: "claude-bridge", id: "claude-sonnet-5-5" };
	// Opus' 85% budget: at 82% it would qualify fresh, but must be 5 under to take over from Sonnet.
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", previous }, [], { claude: { usedPct: 82 } })), "claude-bridge/claude-sonnet-5-5:medium");
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", previous }, [], { claude: { usedPct: 79 } })), "claude-bridge/claude-opus-5-5:medium");
	// Sonnet (90% default) keeps going up to 95% while it is the model in use.
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", previous }, [], { claude: { usedPct: 93 } })), "claude-bridge/claude-sonnet-5-5:medium");
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", previous }, [], { claude: { usedPct: 96 } })), "openai/gpt-6.1-sol:medium");
});

test("tool loops and compaction stay on the model that answered last", () => {
	for (const reason of ["continuation", "direct"] as const)
		assert.equal(pick(input({ profile: "personal", virtualId: "daily", reason, previous: { provider: "openai", id: "gpt-6.1-sol" } }, [], { chatgpt: { usedPct: 93 } })), "openai/gpt-6.1-sol:medium");
});

test("images are routed to a vision model or refused, never dropped", () => {
	const busy = { claude: { exhausted: true }, chatgpt: { exhausted: true } };
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", hasImages: true }, [], busy)), "minimax/MiniMax-M3:medium", "GLM-5.3 is text-only");
	assert.throws(() => chooseRoute(input({ profile: "personal", virtualId: "local", hasImages: true })), (e: Error) => e instanceof RouteError && /accepts images/.test(e.message));
});

// --- failures ---------------------------------------------------------------------------------------

test("transient failures retry the same model once, then fall back", () => {
	const failed = { provider: "claude-bridge", id: "claude-opus-5-5", errorMessage: "529 overloaded_error" };
	const first = chooseRoute(input({ profile: "personal", virtualId: "daily", reason: "retry", failed }));
	assert.equal(first.target.model, "claude-opus-5-5");
	const second = chooseRoute(input({ profile: "personal", virtualId: "daily", reason: "retry", failed, state: first.state }));
	assert.equal(second.target.model, "claude-sonnet-5-5");
	assert.ok(second.state?.sticky && second.state.sticky.index === 1);
});

test("a failure fallback sticks for later prompts, then returns to the primary", () => {
	const state = { sticky: { index: 2, until: 2_000_000 } };
	assert.equal(pick(input({ profile: "personal", virtualId: "daily", state, now: 1_500_000 })), "openai/gpt-6.1-sol:medium");
	const later = chooseRoute(input({ profile: "personal", virtualId: "daily", state, now: 2_500_000 }));
	assert.equal(later.target.model, "claude-opus-5-5");
	assert.deepEqual(later.state, {});
});

test("plan limits skip the rest of that provider; Work points at the override", () => {
	const claude = { provider: "claude-bridge", id: "claude-opus-5-5", errorMessage: "Claude rate limit (seven_day) — resets Oct 9" };
	assert.equal(pick(input({ profile: "personal", virtualId: "deep", reason: "retry", failed: claude })), "openai/gpt-6.1-sol:xhigh");
	const work = { provider: "claude-bridge", id: "claude-sonnet-5-5", errorMessage: "Claude rate limit (spend) — resets Nov 1" };
	assert.throws(
		() => chooseRoute(input({ profile: "work", virtualId: "daily", reason: "retry", failed: work })),
		(e: Error) => /no fallback left for work\/daily/.test(e.message) && /piw --personal-models -c/.test(e.message),
	);
});

test("an unavailable model falls back within the profile", () => {
	const failed = { provider: "claude-bridge", id: "claude-sonnet-5-5", errorMessage: "404 not_found_error: model: claude-sonnet-5-5" };
	assert.equal(pick(input({ profile: "work", virtualId: "daily", reason: "retry", failed })), "claude-bridge/claude-haiku-4-5:off");
});

test("a missing Work login is an actionable error, not a fallback to anything personal", () => {
	const failed = { provider: "claude-bridge", id: "claude-sonnet-5-5", errorMessage: "Not logged in · Please run /login" };
	assert.throws(
		() => chooseRoute(input({ profile: "work", virtualId: "daily", reason: "retry", failed })),
		(e: Error) => /no fallback left/.test(e.message) && /pi-profile --work login/.test(e.message),
	);
});

test("LiteLLM failures are not retried again by Pi (the gateway already retried and failed over)", () => {
	const twoHops = clone();
	twoHops.profiles.personal.models.qwen = { name: "q", level: "low", chain: [
		{ provider: "litellm", model: "bc250/qwen3.6-35b-a3b", thinking: "low" },
		{ provider: "litellm", model: "bc250-local/qwen3.6-35b-a3b", thinking: "low" },
	] };
	const failed = { provider: "litellm", id: "bc250/qwen3.6-35b-a3b", errorMessage: "502 bad gateway" };
	assert.throws(() => chooseRoute(input({ profile: "personal", virtualId: "qwen", reason: "retry", failed, cfg: loadRouting(twoHops) })), /no fallback left for personal\/qwen/);
});

test("local never leaves the box and says what to use while it is offline", () => {
	const overflow = { provider: "litellm", id: "bc250-local/qwen3.6-35b-a3b", errorMessage: "context_length_exceeded" };
	assert.equal(pick(input({ profile: "personal", virtualId: "local", reason: "retry", failed: overflow })), "litellm/bc250-local/qwen3.6-35b-a3b:medium");
	const down = { provider: "litellm", id: "bc250-local/qwen3.6-35b-a3b", errorMessage: "connection refused" };
	assert.throws(() => chooseRoute(input({ profile: "personal", virtualId: "local", reason: "retry", failed: down })), /does not fall back.*BC250 may be offline.*personal\/qwen/);
});

test("fallback checks context size, credentials and usage before switching", () => {
	const quota = { provider: "claude-bridge", id: "claude-opus-5-5", errorMessage: "Claude rate limit (five_hour)" };
	// 400K tokens do not fit GPT-6.1 Sol's 272K window; GLM-5.3 (1M) takes over.
	assert.equal(pick(input({ profile: "personal", virtualId: "deep", reason: "retry", failed: quota, estimatedTokens: 400_000 })), "opencode-go/glm-5.3:high");
	assert.equal(pick(input({ profile: "personal", virtualId: "deep", reason: "retry", failed: quota }, ["openai"])), "opencode-go/glm-5.3:high");
	assert.equal(pick(input({ profile: "personal", virtualId: "deep", reason: "retry", failed: quota }, [], { chatgpt: { exhausted: true } })), "opencode-go/glm-5.3:high");
});

test("missing credentials at the start of a prompt name the fix", () => {
	assert.throws(() => chooseRoute(input({ profile: "personal", virtualId: "fast" }, ["minimax", "opencode-go", "openai"])), (e: Error) => /run ai-sync/.test(e.message) && /\/login openai/.test(e.message));
	assert.equal(pick(input({ profile: "personal", virtualId: "fast" }, ["minimax"])), "opencode-go/deepseek-v4.1-flash:low");
});

test("a tampered Work chain still cannot reach a personal or metered provider", () => {
	const tampered = clone();
	tampered.profiles.work.models.daily.chain.unshift({ provider: "minimax", model: "MiniMax-M3", thinking: "medium" });
	tampered.profiles.work.models.daily.chain.unshift({ provider: "amazon-bedrock", model: "anthropic.claude-opus-5-5", thinking: "medium" });
	assert.equal(pick(input({ profile: "work", virtualId: "daily", cfg: tampered })), "claude-bridge/claude-sonnet-5-5:medium");
});

test("failures are classified the way the router needs", () => {
	const cases: [string, string][] = [
		["Claude rate limit (five_hour) — resets 3pm", "quota"],
		["subscription_sharing_usage_limit_exceeded", "quota"],
		["GoUsageLimitError: Monthly usage limit reached", "quota"],
		["Not logged in · Please run /login", "auth"],
		["401 authentication_error: invalid x-api-key", "auth"],
		["404 model_not_found", "unavailable"],
		["The model gpt-6-astra does not exist or you do not have access to it", "unavailable"],
		["529 overloaded_error", "transient"],
		["fetch failed", "transient"],
		["prompt is too long: 250000 tokens > 200000 maximum", "overflow"],
		["something odd", "other"],
	];
	for (const [text, cls] of cases) assert.equal(classifyError(text), cls, text);
	assert.equal(classifyError(fallbackMarker("quota", "a/b", "c/d")), "quota");
});

test("the fallback marker is retryable under the installed Pi's own patterns", async (t) => {
	const retryJs = process.env.PI_AI_RETRY_JS;
	if (!retryJs) return t.skip("PI_AI_RETRY_JS not set (run.sh finds it)");
	const { isRetryableAssistantError } = await import(retryJs);
	for (const cls of ["quota", "auth", "unavailable"] as const)
		assert.ok(isRetryableAssistantError({ stopReason: "error", errorMessage: fallbackMarker(cls, "openai/gpt-6.1-sol", "opencode-go/glm-5.3") }));
	assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: "insufficient_quota" }), false);
});

test("nextFallback mirrors the retry route", () => {
	const base = { cfg, lookup: (p: string, id: string) => CATALOG.find((m) => m.provider === p && m.id === id), hasAuth: () => true };
	assert.equal(nextFallback({ ...base, profile: "personal", virtualId: "deep", failed: { provider: "claude-bridge", id: "claude-opus-5-5", errorMessage: "usage limit" } })?.model, "gpt-6.1-sol");
	assert.equal(nextFallback({ ...base, profile: "work", virtualId: "daily", failed: { provider: "claude-bridge", id: "claude-sonnet-5-5", errorMessage: "Not logged in" } }), undefined);
	assert.equal(nextFallback({ ...base, profile: "personal", virtualId: "local", failed: { provider: "litellm", id: "bc250-local/qwen3.6-35b-a3b", errorMessage: "404" } }), undefined);
});

test("failures without a fallback name the fix", () => {
	assert.match(failureHint("work", "claude-bridge", "auth")!, /pi-profile --work login/);
	assert.match(failureHint("personal", "claude-bridge", "auth")!, /pi-profile login/);
	assert.match(failureHint("personal", "openai", "auth")!, /\/login openai/);
	assert.match(failureHint("personal", "minimax", "auth")!, /ai-sync/);
	assert.match(failureHint("work", "claude-bridge", "quota")!, /piw --personal-models -c/);
	assert.equal(failureHint("personal", "claude-bridge", "quota"), undefined);
});

// --- auto -----------------------------------------------------------------------------------------------

test("auto: the classifier's answer is parsed defensively", () => {
	const tiers = ["fast", "daily", "deep"];
	assert.deepEqual(parseTier('{"tier":"deep","why":"concurrency bug"}', tiers), { tier: "deep", why: "concurrency bug" });
	assert.deepEqual(parseTier('Sure! {"tier": "FAST", "why": "rename"}', tiers), { tier: "fast", why: "rename" });
	assert.deepEqual(parseTier("I would say daily.", tiers), { tier: "daily", why: "" });
	assert.equal(parseTier('{"tier":"ultra"}', tiers), undefined);
});

test("auto: the Decisions API gets the tiers as choices and its answer becomes a tier", () => {
	const tiers = ["fast", "daily", "deep"];
	const req: any = decisionsRequest("gpt-6-luna", tiers, "New user message:\nrename foo");
	assert.equal(req.model, "gpt-6-luna");
	assert.equal(req.questions[0].type, "choice");
	assert.deepEqual(req.questions[0].choices.map((c: any) => c.value), tiers);
	assert.match(req.questions[0].choices[2].description, /architecture/);
	const answer = (choice: string, probs: number[], confidence: number) => ({
		answers: [{ type: "choice", name: "tier", choice, confidence, probabilities: tiers.map((value, i) => ({ value, probability: probs[i] })) }],
	});
	assert.deepEqual(parseDecision(answer("fast", [0.9, 0.08, 0.02], 0.88), tiers), { tier: "fast", why: "90%" });
	assert.deepEqual(parseDecision(answer("daily", [0.05, 0.48, 0.47], 0.3), tiers), { tier: "deep", why: "unsure daily 48% / deep 47%" }, "unsure: the stronger of the top two");
	assert.equal(parseDecision({ answers: [{ type: "refusal", name: "tier" }] }, tiers), undefined);
	assert.equal(parseDecision(answer("ultra", [0, 0, 0], 1), tiers), undefined);
	assert.equal(parseDecision({}, tiers), undefined);
});

test("auto: short follow-ups skip the classifier, long chats are not moved down a tier", () => {
	assert.equal(isShortFollowUp("yes"), true);
	assert.equal(isShortFollowUp("go on please"), true);
	assert.equal(isShortFollowUp("why does this fail?"), false);
	assert.equal(isShortFollowUp("refactor the session store to use sqlite"), false);
	const tiers = ["fast", "daily", "deep"];
	assert.equal(decideTier(undefined, undefined, tiers, "daily", 0), "daily");
	assert.equal(decideTier("daily", "deep", tiers, "daily", 200_000), "deep", "upgrades always apply");
	assert.equal(decideTier("deep", "fast", tiers, "daily", 5_000), "fast", "a short chat can step down");
	assert.equal(decideTier("deep", "fast", tiers, "daily", 50_000), "deep", "a long one keeps its cache");
	assert.equal(decideTier("deep", "nonsense", tiers, "daily", 0), "deep");
});

// --- conversation, memory ----------------------------------------------------------------------------

test("conversation facts count images and approximate tokens", () => {
	const f = conversationFacts([
		{ role: "user", content: "x".repeat(400) },
		{ role: "user", content: [{ type: "text", text: "y".repeat(40) }, { type: "image", data: "…" }] },
		{ role: "toolResult", content: [{ type: "image", data: "…" }] },
	]);
	assert.deepEqual(f, { hasImages: true, estimatedTokens: 110 + 3200 });
});

test("memory tools stay inside the profile's scope", () => {
	const home = { home: "personal/jan" };
	assert.equal(memoryToolBlock("work", "memory_recall", {}, home), undefined);
	assert.equal(memoryToolBlock("work", "memory_get", { namespace: "work/api" }, home), undefined);
	assert.equal(memoryToolBlock("work", "memory_get", { namespace: "personal/jan" }, home), undefined, "home overlay is readable");
	assert.match(memoryToolBlock("work", "memory_update", { namespace: "personal/jan" }, home)!, /only write work/);
	assert.match(memoryToolBlock("work", "memory_get", { namespace: "homelab/home-ops" }, home)!, /only read work/);
	assert.match(memoryToolBlock("work", "memory_remember", { visibility: "personal" }, home)!, /visibility personal/);
	assert.equal(memoryToolBlock("work", "memory_remember", { visibility: "project" }, home), undefined);
	assert.match(memoryToolBlock("personal", "memory_list", { namespace: "work/api" }, home)!, /cannot access Work/);
	assert.equal(memoryToolBlock("personal", "memory_remember", { visibility: "personal" }, home), undefined);
	assert.match(memoryToolBlock("personal", "memory_recall", {}, { ...home, memoryOff: "PI_MEMINI=off" })!, /memory is off/);
	assert.equal(memoryToolBlock("work", "read", { namespace: "homelab/x" }, home), undefined);
});
