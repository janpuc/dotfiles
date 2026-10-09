// Unit tests for home/dot_pi/shared/extensions/profile/usage.ts. Payloads are synthetic but
// shaped like the real ones (Claude Agent SDK /usage data, codex app-server rate limits,
// OpenCode Go /usage, MiniMax /token_plan/remains).

import assert from "node:assert/strict";
import { test } from "node:test";
import { poolOf, isQuotaError, DEFAULT_USAGE, describe, fromClaude, fromCodex, fromMinimax, fromOpencodeGo, limitedUntilFrom, mergeUsage, pressure } from "../../home/dot_pi/shared/extensions/profile/usage.ts";

const NOW = Date.parse("2026-10-07T10:00:00Z");
const at = "2026-10-07T09:58:00Z";
const opts = { exhaustedPercent: 97, staleMinutes: 30 };

test("Claude: session, weekly and model-scoped weekly windows", () => {
	const u = fromClaude({
		subscription_type: "max",
		rate_limits: { limits: [
			{ kind: "session", group: "session", percent: 31, resets_at: "2026-10-07T11:50:00Z", scope: null },
			{ kind: "weekly_all", group: "weekly", percent: 71, resets_at: "2026-10-10T21:00:00Z", scope: null },
			{ kind: "weekly_scoped", group: "weekly", percent: 61, resets_at: "2026-10-10T21:00:00Z", scope: { model: { id: null, display_name: "Fable" } } },
		] },
	}, at);
	assert.deepEqual(u.windows.map((w) => `${w.name}:${w.usedPct}`), ["5h:31", "week:71", "week:fable:61"]);
	const opus = pressure(u, "claude-opus-5-5", NOW, opts)!;
	assert.equal(opus.usedPct, 71);
	// 71% used with ~50% of the week gone: about 21 points ahead of pace.
	assert.ok(opus.aheadOfPace > 18 && opus.aheadOfPace < 24, String(opus.aheadOfPace));
	assert.equal(pressure({ ...u, windows: u.windows.filter((w) => w.name !== "week") }, "claude-fable-5-1", NOW, opts)!.usedPct, 61, "Fable's own cap applies to Fable");
	assert.equal(pressure({ ...u, windows: u.windows.filter((w) => w.name !== "week") }, "claude-opus-5-5", NOW, opts)!.usedPct, 31, "…and only to Fable");
});

test("Claude Enterprise: spend-metered seat", () => {
	const u = fromClaude({ subscription_type: "enterprise", rate_limits: { limits: [], spend: { enabled: true, percent: 82 } } }, at, "Claude (enterprise)");
	assert.deepEqual(u.windows, [{ name: "spend", usedPct: 82 }]);
	assert.equal(pressure(u, "claude-sonnet-5-5", NOW, opts)!.usedPct, 82);
});

test("ChatGPT: the Codex pool's 5h and weekly windows, and a reached limit", () => {
	const r = { rateLimits: { planType: "plus", primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: 1791375221 }, secondary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1791962021 } } };
	const u = fromCodex(r, at);
	assert.equal(u.plan, "plus");
	assert.deepEqual(u.windows.map((w) => `${w.name}:${w.usedPct}`), ["5h:96", "week:15"]);
	const limited = fromCodex({ ...r, rateLimits: { ...r.rateLimits, rateLimitReachedType: "primary" } }, at);
	assert.equal(pressure(limited, "gpt-6.1-sol", NOW, opts)!.exhausted, true);
});

test("OpenCode Go: one pool with 5h/week/month, rate-limited counts as full", () => {
	const u = fromOpencodeGo({ usage: { rolling: { status: "ok", percent: 0, resetsAt: "2026-10-07T13:23:35Z" }, weekly: { status: "ok", percent: 70, resetsAt: "2026-10-12T00:00:00Z" }, monthly: { status: "rate-limited", percent: 35, resetsAt: "2026-11-06T07:46:46Z" } } }, at);
	assert.deepEqual(u.windows.map((w) => `${w.name}:${w.usedPct}`), ["5h:0", "week:70", "month:100"]);
	assert.equal(pressure(u, "glm-5.3", NOW, opts)!.exhausted, true);
});

test("MiniMax: remaining percent turns into used percent; status codes win", () => {
	const u = fromMinimax({ base_resp: { status_code: 0 }, model_remains: [
		{ model_name: "general", current_interval_remaining_percent: 99, current_interval_status: 1, current_weekly_remaining_percent: 93, current_weekly_status: 1, end_time: 1791367200000, weekly_end_time: 1791763200000 },
		{ model_name: "video", current_interval_remaining_percent: 100, current_interval_status: 3 },
	] }, at);
	assert.deepEqual(u.windows.map((w) => `${w.name}:${w.usedPct}`), ["5h:1", "week:7"]);
	const exhausted = fromMinimax({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 40, current_interval_status: 2 }] }, at);
	assert.equal(exhausted.windows[0].usedPct, 100);
	assert.throws(() => fromMinimax({ base_resp: { status_code: 1004, status_msg: "auth failed" } }, at), /auth failed/);
});

test("stale data is unknown, an elapsed window has reset, and a plan-limit error blocks until its reset", () => {
	const u = fromOpencodeGo({ usage: { weekly: { status: "ok", percent: 95, resetsAt: "2026-10-07T09:00:00Z" } } }, at);
	assert.equal(pressure(u, "x", NOW, opts)!.usedPct, 0, "the weekly window already reset");
	assert.equal(pressure({ ...u, fetchedAt: "2026-10-07T08:00:00Z" }, "x", NOW, opts), undefined, "2h old: unknown, not full");
	const limited = { ...u, fetchedAt: "2026-10-01T00:00:00Z", limitedUntil: "2026-10-07T11:00:00Z" };
	assert.equal(pressure(limited, "x", NOW, opts)!.exhausted, true, "a known limit outlives stale windows");
	assert.equal(pressure(undefined, "x", NOW, opts), undefined);
	assert.match(describe(fromCodex({ rateLimits: { primary: { usedPercent: 96, windowDurationMins: 300 } } }, at), NOW, opts), /ChatGPT: 5h 96%/);
});

test("limit errors give their reset time when they say so, else an hour", () => {
	assert.equal(limitedUntilFrom("Usage limit reached, resets in 90 min", NOW), new Date(NOW + 90 * 60_000).toISOString());
	assert.equal(limitedUntilFrom("insufficient_quota", NOW), new Date(NOW + 3_600_000).toISOString());
});

test("Claude answers without `limits` fall back to the per-window fields", () => {
	const u = fromClaude({ subscription_type: "max", rate_limits: { five_hour: { utilization: 35, resets_at: "2026-10-07T11:50:00Z" }, seven_day: { utilization: 72, resets_at: "2026-10-10T21:00:00Z" } } }, at);
	assert.deepEqual(u.windows.map((w) => `${w.name}:${w.usedPct}`), ["5h:35", "week:72"]);
});

test("a failed or empty refresh never blanks good data", () => {
	const good = fromOpencodeGo({ usage: { weekly: { status: "ok", percent: 70, resetsAt: "2026-10-12T00:00:00Z" } } }, at);
	const afterError = mergeUsage(good, "opencode-go", new Error("HTTP 502"));
	assert.equal(afterError.windows[0].usedPct, 70);
	assert.equal(afterError.fetchedAt, good.fetchedAt, "keeps aging toward stale");
	assert.equal(afterError.fetchError, "HTTP 502");
	const afterEmpty = mergeUsage(good, "opencode-go", { ...good, windows: [], fetchedAt: "2026-10-07T09:59:00Z" });
	assert.equal(afterEmpty.windows.length, 1);
	assert.match(afterEmpty.fetchError!, /without usage windows/);
	const fresh = mergeUsage({ ...good, limitedUntil: "2026-10-07T11:00:00Z" }, "opencode-go", { ...good, fetchedAt: "2026-10-07T09:59:30Z" });
	assert.equal(fresh.limitedUntil, "2026-10-07T11:00:00Z", "a known plan limit survives a refresh");
	assert.equal(fresh.fetchError, undefined);
});


test("native provider/model pairs map only to the fixed usage pools", () => {
	for (const [provider, id, pool] of [
		["claude-bridge", "claude-opus-5-5", "claude"], ["openai", "gpt-6-astra", "chatgpt"],
		["litellm", "opencode-go/glm", "opencode-go"], ["litellm", "minimax/MiniMax-M3", "minimax"],
		["minimax", "MiniMax-M3", "minimax"], ["opencode-go", "glm", "opencode-go"],
		["litellm", "bc250-local/qwen", undefined], ["unknown", "model", undefined],
	]) assert.equal(poolOf({ provider: provider!, id }), pool);
	assert.deepEqual(DEFAULT_USAGE, { refreshMinutes: 5, staleMinutes: 30, exhaustedPercent: 97 });
	assert.equal(isQuotaError("Claude rate limit (weekly) — resets tomorrow"), true);
	assert.equal(isQuotaError("GoUsageLimitError"), true);
	assert.equal(isQuotaError("429 too many requests"), false);
});
