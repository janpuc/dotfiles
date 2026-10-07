// Rendering of subscription usage for the TUI: the one-line bars under the editor and the
// /usage panel. Pure functions over usage.ts data; index.ts does the wiring.

import { pressure, shortTime, type SubUsage, type UsageOptions } from "./usage.ts";

export type Part = [color: string | undefined, text: string];
export interface Paint {
	fg(color: string, text: string): string;
}
export interface PoolView {
	name: string;
	u: SubUsage | undefined;
	active: boolean;
}

const BAR = 8;
const CALM = 30;
const SEP: Part = ["dim", " · "];

export function duration(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const length = (parts: Part[]) => parts.reduce((n, [, s]) => n + s.length, 0);

/** Colour the parts, cutting the text at `width` visible columns. */
export function paint(parts: Part[], t: Paint, width = Infinity): string {
	let room = width;
	let out = "";
	for (const [c, s] of parts) {
		if (room <= 0) break;
		const text = s.length > room ? s.slice(0, room) : s;
		room -= text.length;
		out += c ? t.fg(c, text) : text;
	}
	return out;
}

/** Green below 60%, yellow from 60%, red from 85%. */
function severity(usedPct: number): string {
	return usedPct >= 85 ? "error" : usedPct >= 60 ? "warning" : "success";
}

function bar(usedPct: number, color: string, cells = BAR): Part[] {
	const filled = Math.min(cells, Math.round((usedPct / 100) * cells));
	return Array.from({ length: cells }, (_, i): Part => (i < filled ? [color, "▰"] : ["dim", "▱"]));
}

interface State {
	pr?: ReturnType<typeof pressure>;
	limited?: string;
	/** Old numbers or a failed refresh: shown dimmed with a "!". */
	doubtful: boolean;
}

function stateOf(u: SubUsage, now: number, opts: UsageOptions): State {
	const doubtful = now - Date.parse(u.fetchedAt) > opts.staleMinutes * 60_000 || !!u.fetchError;
	if (u.limitedUntil && Date.parse(u.limitedUntil) > now) return { doubtful, limited: `until ${shortTime(u.limitedUntil, now)}` };
	if (u.limitReached) return { doubtful, limited: "limit" };
	if (!u.windows.length) return { doubtful };
	return { doubtful, pr: pressure(u, "", now, { ...opts, staleMinutes: Infinity }) };
}

/** Level 0 is the full segment; 1 drops the reset countdown; 2 also drops the window name. */
function segment(p: PoolView, now: number, opts: UsageOptions, level: number): Part[] {
	const label: Part = [p.active ? "accent" : "muted", `${p.active ? "▸" : ""}${p.name}`];
	if (!p.u) return [label, [undefined, " "], ["dim", "?"]];
	const st = stateOf(p.u, now, opts);
	if (st.limited) return [label, [undefined, " "], ["error", `× ${st.limited}`]];
	if (!st.pr) return [label, [undefined, " "], ["dim", "?"], ["warning", " !"]];
	const { pr } = st;
	const color = st.doubtful ? "dim" : severity(pr.usedPct);
	const parts: Part[] = [label, [undefined, " "], ...bar(pr.usedPct, color), [undefined, " "], [color, `${Math.round(pr.usedPct)}%`]];
	if (level < 2 && pr.window) parts.push(["dim", ` ${pr.window}`]);
	if (level < 1 && pr.resetsAt && !st.doubtful && pr.usedPct >= 60)
		parts.push(["dim", ` ↻${duration(Date.parse(pr.resetsAt) - now)}`]);
	if (st.doubtful) parts.push(["warning", " !"]);
	return parts;
}

/** The line under the editor: one bar per subscription, or a quiet summary while all is calm. */
export function renderBars(pools: PoolView[], now: number, opts: UsageOptions, t: Paint, width: number): string {
	const states = pools.map((p) => (p.u ? stateOf(p.u, now, opts) : undefined));
	const calm = states.every((s) => s && !s.limited && !s.doubtful && s.pr && s.pr.usedPct < CALM);
	if (calm && pools.length) {
		let top = 0;
		let name = "";
		states.forEach((s, i) => {
			if (s!.pr!.usedPct >= top) [top, name] = [s!.pr!.usedPct, pools[i].name];
		});
		return paint([["muted", "usage "], ["success", "ok"], ["dim", ` · highest ${name} ${Math.round(top)}%`]], t, width);
	}
	let segs: Part[][] = [];
	for (const level of [0, 1, 2]) {
		segs = pools.map((p) => segment(p, now, opts, level));
		if (segs.reduce((n, s) => n + length(s), 0) + 3 * (segs.length - 1) <= width) break;
	}
	// Still too wide at the most compact level: drop trailing subscriptions rather than wrap.
	const kept: Part[] = [];
	let used = 0;
	for (const s of segs) {
		const need = length(s) + (kept.length ? 3 : 0);
		if (used + need > width) break;
		used += need;
		if (kept.length) kept.push(SEP);
		kept.push(...s);
	}
	return paint(kept, t, width);
}

/** The /usage panel: every window of every subscription, then where each virtual model routes. */
export function renderPanel(pools: PoolView[], routing: string[], now: number, opts: UsageOptions, t: Paint, width: number): string[] {
	const lines: string[] = [""];
	for (const p of pools) {
		const u = p.u;
		if (!u) {
			lines.push(paint([["accent", p.name], ["dim", "  not fetched yet"]], t, width));
			continue;
		}
		const age = Math.round((now - Date.parse(u.fetchedAt)) / 60_000);
		const head: Part[] = [["accent", `${p.active ? "▸ " : ""}${u.label}`], ["dim", `${u.plan ? ` (${u.plan})` : ""} · updated ${age}m ago`]];
		if (u.limitedUntil && Date.parse(u.limitedUntil) > now) head.push(["error", `  × limited until ${shortTime(u.limitedUntil, now)}`]);
		else if (u.limitReached) head.push(["error", `  × limit reached (${u.limitReached})`]);
		if (age > opts.staleMinutes) head.push(["warning", "  stale"]);
		lines.push(paint(head, t, width));
		if (u.fetchError) lines.push(paint([["warning", `  refresh failed: ${u.fetchError}`]], t, width));
		for (const w of u.windows) {
			const expired = !!w.resetsAt && Date.parse(w.resetsAt) <= now;
			const color = expired ? "dim" : severity(w.usedPct);
			const parts: Part[] = [[undefined, `  ${w.name.padEnd(12)} `], ...bar(expired ? 0 : w.usedPct, color, 20), [undefined, " "], [color, `${expired ? 0 : Math.round(w.usedPct)}%`.padStart(4)]];
			if (w.resetsAt) parts.push(["dim", expired ? "  has reset" : `  resets ${shortTime(w.resetsAt, now)} (in ${duration(Date.parse(w.resetsAt) - now)})`]);
			lines.push(paint(parts, t, width));
		}
		lines.push("");
	}
	if (routing.length) {
		lines.push(paint([["muted", "routing"]], t, width));
		for (const r of routing) lines.push(paint([["dim", `  ${r}`]], t, width));
		lines.push("");
	}
	lines.push(paint([["dim", "esc closes · /usage refresh re-reads now"]], t, width));
	return lines;
}
