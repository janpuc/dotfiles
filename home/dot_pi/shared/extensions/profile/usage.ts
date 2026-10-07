// Subscription usage: normalise what each plan reports into windows (used %, reset, length,
// optional model scope) and turn them into routing pressure. Pure functions; usage-sources.ts
// does the I/O.

export interface UsageWindow {
	name: string;
	usedPct: number;
	resetsAt?: string;
	lengthMs?: number;
	/** Lower-case model family the window applies to (e.g. "fable"); unset = every model. */
	scope?: string;
}

export interface SubUsage {
	sub: string;
	label: string;
	plan?: string;
	windows: UsageWindow[];
	fetchedAt: string;
	/** Set from a plan-limit error; the subscription is unusable until then. */
	limitedUntil?: string;
	/** The plan itself reports the limit as reached. */
	limitReached?: string;
	/** The last refresh failed; windows are from the previous good one and age out as stale. */
	fetchError?: string;
}

const H = 3_600_000;
const pct = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined);
const iso = (v: unknown) => (typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v).toISOString() : typeof v === "string" && v ? new Date(v).toISOString() : undefined);

/** Claude Agent SDK `usage_EXPERIMENTAL…` result (plan windows, or Enterprise spend). */
export function fromClaude(r: any, fetchedAt: string, label = "Claude"): SubUsage {
	const windows: UsageWindow[] = [];
	for (const l of r?.rate_limits?.limits ?? []) {
		const used = pct(l?.percent);
		if (used === undefined) continue;
		const scope = typeof l?.scope?.model?.display_name === "string" ? l.scope.model.display_name.toLowerCase() : undefined;
		windows.push({
			name: l.group === "session" ? "5h" : l.group === "weekly" ? (scope ? `week:${scope}` : "week") : String(l.kind ?? l.group),
			usedPct: used,
			resetsAt: iso(l.resets_at),
			lengthMs: l.group === "session" ? 5 * H : l.group === "weekly" ? 168 * H : undefined,
			scope,
		});
	}
	// Some answers carry only the per-window fields; read those when `limits` is missing.
	if (!windows.length) {
		const legacy: [string, string, number, string?][] = [["five_hour", "5h", 5 * H], ["seven_day", "week", 168 * H], ["seven_day_opus", "week:opus", 168 * H, "opus"], ["seven_day_sonnet", "week:sonnet", 168 * H, "sonnet"]];
		for (const [field, name, lengthMs, scope] of legacy) {
			const used = pct(r?.rate_limits?.[field]?.utilization);
			if (used !== undefined) windows.push({ name, usedPct: used, resetsAt: iso(r.rate_limits[field].resets_at), lengthMs, ...(scope ? { scope } : {}) });
		}
	}
	const spend = r?.rate_limits?.spend;
	if (spend?.enabled && pct(spend.percent) !== undefined) windows.push({ name: "spend", usedPct: pct(spend.percent)! });
	return { sub: "claude", label, plan: r?.subscription_type ?? undefined, windows, fetchedAt };
}

/** Codex app-server `account/rateLimits/read` result (the ChatGPT plan's Codex pool). */
export function fromCodex(r: any, fetchedAt: string): SubUsage {
	const rl = r?.rateLimits ?? {};
	const windows: UsageWindow[] = [];
	for (const w of [rl.primary, rl.secondary]) {
		const used = pct(w?.usedPercent);
		if (used === undefined) continue;
		const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined;
		windows.push({ name: mins === 300 ? "5h" : mins === 10080 ? "week" : `${mins}m`, usedPct: used, resetsAt: iso(w.resetsAt), lengthMs: mins ? mins * 60_000 : undefined });
	}
	const limited = rl.rateLimitReachedType || r?.ordinaryUsageAllowed === false;
	return { sub: "chatgpt", label: "ChatGPT", plan: rl.planType ?? undefined, windows, fetchedAt, ...(limited ? { limitReached: String(rl.rateLimitReachedType ?? "ordinary usage not allowed") } : {}) };
}

/** OpenCode Go `GET /zen/go/v1/usage`: one dollar-metered pool with 5h/week/month windows. */
export function fromOpencodeGo(r: any, fetchedAt: string): SubUsage {
	const windows: UsageWindow[] = [];
	const spec: [string, string, number][] = [["rolling", "5h", 5 * H], ["weekly", "week", 168 * H], ["monthly", "month", 720 * H]];
	for (const [key, name, lengthMs] of spec) {
		const w = r?.usage?.[key];
		const used = w?.status === "rate-limited" ? 100 : pct(w?.percent);
		if (used !== undefined) windows.push({ name, usedPct: used, resetsAt: iso(w?.resetsAt), lengthMs });
	}
	return { sub: "opencode-go", label: "OpenCode Go", windows, fetchedAt };
}

/** MiniMax `GET /v1/token_plan/remains`: the "general" pool's 5h interval and weekly window. */
export function fromMinimax(r: any, fetchedAt: string): SubUsage {
	if (r?.base_resp && r.base_resp.status_code !== 0) throw new Error(`MiniMax: ${r.base_resp.status_msg ?? r.base_resp.status_code}`);
	const pool = (r?.model_remains ?? []).find((m: any) => m?.model_name === "general") ?? r?.model_remains?.[0];
	const windows: UsageWindow[] = [];
	const left = (v: unknown, status: unknown) => (status === 2 ? 100 : status === 3 ? 0 : pct(v) === undefined ? undefined : 100 - pct(v)!);
	const interval = left(pool?.current_interval_remaining_percent, pool?.current_interval_status);
	if (interval !== undefined) windows.push({ name: "5h", usedPct: interval, resetsAt: iso(pool?.end_time), lengthMs: 5 * H });
	const weekly = left(pool?.current_weekly_remaining_percent, pool?.current_weekly_status);
	if (weekly !== undefined) windows.push({ name: "week", usedPct: weekly, resetsAt: iso(pool?.weekly_end_time), lengthMs: 168 * H });
	return { sub: "minimax", label: "MiniMax", windows, fetchedAt };
}

// --- pressure ---------------------------------------------------------------------------------

export interface Pressure {
	/** Highest used % among the windows that apply to the model. */
	usedPct: number;
	/** How far a window with a known length is ahead of a straight-line pace, in points. */
	aheadOfPace: number;
	exhausted: boolean;
	/** Name of the window behind `usedPct` (e.g. "week"). */
	window: string;
	/** Reset time, fraction of the window already elapsed, and points ahead of pace for that window. */
	resetsAt?: string;
	elapsed?: number;
	windowAhead?: number;
	/** E.g. "week 71% (resets Fri 23:00)". */
	worst: string;
}

export interface UsageOptions {
	exhaustedPercent: number;
	staleMinutes: number;
}

export function windowApplies(w: UsageWindow, modelId: string): boolean {
	return !w.scope || modelId.toLowerCase().includes(w.scope);
}

/** Pressure for one model of a subscription, or undefined when nothing current is known. */
export function pressure(u: SubUsage | undefined, modelId: string, now: number, opts: UsageOptions): Pressure | undefined {
	if (!u) return undefined;
	if (u.limitedUntil && Date.parse(u.limitedUntil) > now)
		return { usedPct: 100, aheadOfPace: 100, exhausted: true, window: "limit", worst: `limit reached until ${shortTime(u.limitedUntil, now)}` };
	if (now - Date.parse(u.fetchedAt) > opts.staleMinutes * 60_000) return undefined;
	let usedPct = 0;
	let aheadOfPace = 0;
	let worst = "";
	let window = "";
	let resetsAt: string | undefined;
	let elapsed: number | undefined;
	let windowAhead: number | undefined;
	for (const w of u.windows) {
		if (!windowApplies(w, modelId)) continue;
		// A window whose reset has passed has started over.
		if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue;
		if (w.usedPct >= usedPct) {
			usedPct = w.usedPct;
			window = w.name;
			resetsAt = w.resetsAt;
			elapsed = w.lengthMs && w.resetsAt ? Math.max(0, Math.min(1, 1 - (Date.parse(w.resetsAt) - now) / w.lengthMs)) : undefined;
			windowAhead = elapsed === undefined ? undefined : w.usedPct - elapsed * 100;
			worst = `${w.name} ${Math.round(w.usedPct)}%${w.resetsAt ? ` (resets ${shortTime(w.resetsAt, now)})` : ""}`;
		}
		if (w.lengthMs && w.resetsAt) {
			const elapsed = 1 - (Date.parse(w.resetsAt) - now) / w.lengthMs;
			aheadOfPace = Math.max(aheadOfPace, w.usedPct - Math.max(0, Math.min(1, elapsed)) * 100);
		}
	}
	return { usedPct, aheadOfPace, window, resetsAt, elapsed, windowAhead, exhausted: usedPct >= opts.exhaustedPercent || !!u.limitReached, worst: u.limitReached ? `limit reached (${u.limitReached})` : worst };
}

export function shortTime(isoTime: string, now: number): string {
	const d = new Date(isoTime);
	const sameDay = d.toDateString() === new Date(now).toDateString();
	const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return sameDay ? hm : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${hm}`;
}

/** "Claude 5h 31% · week 71% · week:fable 61%" style summary for /usage and the usage tool. */
export function describe(u: SubUsage, now: number, opts: UsageOptions): string {
	const age = Math.round((now - Date.parse(u.fetchedAt)) / 60_000);
	const stale = age > opts.staleMinutes ? ` (stale, ${age} min old)` : "";
	const windows = u.windows.map((w) => `${w.name} ${Math.round(w.usedPct)}%${w.resetsAt ? ` → ${shortTime(w.resetsAt, now)}` : ""}`).join(" · ");
	const limited = u.limitedUntil && Date.parse(u.limitedUntil) > now ? ` · LIMITED until ${shortTime(u.limitedUntil, now)}` : "";
	const notes = [u.limitReached && `limit reached (${u.limitReached})`, u.fetchError && `refresh failed: ${u.fetchError}`].filter(Boolean).join(" · ");
	return `${u.label}${u.plan ? ` (${u.plan})` : ""}: ${windows || "no data"}${limited}${notes ? ` · ${notes}` : ""}${stale}`;
}

/** When a plan-limit error says when it resets, use that; otherwise assume an hour. */
export function limitedUntilFrom(errorText: string, now: number): string {
	const m = /resets?\s+(?:at\s+|in\s+)?([^—.;,)]+)/i.exec(errorText);
	if (m) {
		const inMin = /(\d+)\s*min/i.exec(m[1]);
		const inH = /(\d+)\s*h/i.exec(m[1]);
		if (inMin || inH) return new Date(now + (inH ? +inH[1] * H : 0) + (inMin ? +inMin[1] * 60_000 : 0)).toISOString();
		const parsed = Date.parse(m[1]);
		if (!Number.isNaN(parsed) && parsed > now) return new Date(parsed).toISOString();
	}
	return new Date(now + H).toISOString();
}

/**
 * Fold one refresh result into the cached record. A failure, or an answer without any window
 * (seen from Claude's usage API under load), keeps the previous windows and their fetch time,
 * so they age out as stale instead of reading as "nothing used".
 */
export function mergeUsage(prev: SubUsage | undefined, pool: string, next: SubUsage | Error): SubUsage {
	const failed = next instanceof Error ? next.message : !next.windows.length && !next.limitReached ? "answer without usage windows" : undefined;
	if (failed || next instanceof Error)
		return { ...(prev ?? { sub: pool, label: pool, windows: [], fetchedAt: new Date(0).toISOString() }), fetchError: failed };
	return { ...next, limitedUntil: prev?.limitedUntil };
}
