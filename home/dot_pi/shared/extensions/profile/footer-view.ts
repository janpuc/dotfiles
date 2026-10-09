// The footer under the editor: who and where (profile, directory, branch, memory) and what is
// answering (model, thinking, context). Pure rendering over a snapshot; index.ts gathers it.

export interface FooterTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

export interface FooterState {
	profile: "personal" | "work";
	blocked: boolean;
	cwd: string;
	home?: string;
	branch?: string;
	sessionName?: string;
	/** The launcher's memini verdict, e.g. "ok: homelab/home-ops (pin)" or "degraded: …". */
	memory: string;
	model?: { provider: string; id: string };
	/** Thinking level of a directly selected model. */
	thinking?: string;
	context?: { percent: number | null; window: number };
	/** Statuses other extensions set, already sanitised. */
	statuses: string[];
}

type Style = "inverse" | "bold" | undefined;
type Seg = [color: string | undefined, text: string, style?: Style];

const width = (segs: Seg[]) => segs.reduce((n, [, s]) => n + [...s].length, 0);

function paint(segs: Seg[], t: FooterTheme, max: number): string {
	let room = max;
	let out = "";
	for (const [c, s, style] of segs) {
		if (room <= 0) break;
		const chars = [...s];
		const text = chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join("")}…` : s;
		room -= Math.min(chars.length, room);
		let styled = c ? t.fg(c, text) : text;
		if (style === "bold") styled = t.bold(styled);
		if (style === "inverse") styled = t.inverse(styled);
		out += styled;
	}
	return out;
}

/**
 * Left and right halves on one line. The right side steps down to shorter forms first; if the left
 * still does not fit, it is cut to leave room for the shortest right, and only on a very narrow
 * terminal is the right dropped.
 */
function line(left: Seg[], rights: Seg[][], t: FooterTheme, max: number): string {
	for (const right of rights) {
		const gap = max - width(left) - width(right);
		if (gap >= 2) return paint(left, t, max) + " ".repeat(gap) + paint(right, t, max);
	}
	const last = rights[rights.length - 1] ?? [];
	const room = max - width(last) - 2;
	if (!width(last) || room < 20) return paint(left, t, max);
	return paint(left, t, room) + "  " + paint(last, t, max);
}

export function shortTokens(n: number): string {
	return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function shortCwd(cwd: string, home?: string): string {
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
	return cwd;
}

const THINKING: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function badge(s: FooterState): Seg[] {
	const segs: Seg[] =
		s.profile === "work" ? [["warning", " work ", "inverse"]]
		: [["success", " personal ", "inverse"]];
	if (s.blocked) segs.push([undefined, " "], ["error", " blocked ", "inverse"]);
	return segs;
}

/** Full and compact forms of the memory indicator. */
function memory(s: FooterState): Seg[][] {
	const [state, ...rest] = s.memory.split(":");
	const detail = rest.join(":").trim();
	if (state === "ok") {
		const ns = detail.replace(/\s*\(.*\)$/, "") || "ok";
		return [[["success", "● "], ["muted", "mem "], ["text", ns]], [["success", "● "], ["text", ns]], [["success", "●"]]];
	}
	const color = state === "conflict" ? "error" : state === "degraded" ? "warning" : "dim";
	const word = state === "off" ? "off" : state || "unknown";
	return [[[color, "● "], ["muted", "mem "], [color, word]], [[color, "● "], [color, word]], [[color, "●"]]];
}

function contextGauge(c: FooterState["context"]): Seg[][] {
	if (!c || !c.window) return [[]];
	const win = shortTokens(c.window);
	if (c.percent === null) return [[["muted", "ctx "], ["dim", `? of ${win}`]], [["dim", "ctx ?"]]];
	const p = Math.max(0, Math.min(100, c.percent));
	const color = p > 90 ? "error" : p > 70 ? "warning" : "success";
	const cells = 8;
	const filled = Math.min(cells, Math.round((p / 100) * cells));
	const bar: Seg[] = [[color, "▰".repeat(filled)], ["dim", "▱".repeat(cells - filled)]];
	const pct: Seg = [color, `${Math.round(p)}%`];
	return [
		[["muted", "ctx "], ...bar, [undefined, " "], pct, ["dim", ` of ${win}`]],
		[["muted", "ctx "], ...bar, [undefined, " "], pct],
		[["muted", "ctx "], pct],
	];
}

function modelSegs(s: FooterState): Seg[] {
	const m = s.model;
	if (!m) return [["dim", "no model"]];
	const think = (level?: string): Seg[] => (level ? [["dim", " · "], [THINKING[level] ?? "muted", level]] : []);
	return [["text", `${m.provider}/`], ["text", m.id, "bold"], ...think(s.thinking)];
}

export function renderFooter(s: FooterState, t: FooterTheme, max: number): string[] {
	const where: Seg[] = [...badge(s), [undefined, " "], ["text", shortCwd(s.cwd, s.home)]];
	if (s.branch) where.push(["dim", " ⎇ "], ["muted", s.branch]);
	if (s.sessionName) where.push(["dim", " · "], ["muted", s.sessionName]);
	const lines = [line(where, memory(s), t, max), line(modelSegs(s), contextGauge(s.context), t, max)];
	if (s.statuses.length) lines.push(paint([["dim", s.statuses.join("  ·  ")]], t, max));
	return lines;
}
