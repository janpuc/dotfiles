import { getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, Text, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export interface WorkerView {
	id: string; agent: string; task: string; model: string; thinking: string; state: string; started: string; finished?: string;
	inputTokens: number; outputTokens: number; currentTool?: string;
	messages: { role: string; content: unknown; toolName?: string; isError?: boolean; errorMessage?: string }[];
	partialText?: string; partialThinking?: string; error?: string;
}
export interface WorkerUIActions {
	list(): WorkerView[]; cancel(id: string): Promise<void>; submit(id: string, text: string): Promise<void>;
	subscribe(fn: () => void): () => void;
}
// Text from workers is untrusted terminal content, including titles, args and error messages.
export function displayText(value: unknown, limit = 2048): string {
	if (typeof value !== "string") return "";
	return value.slice(0, limit)
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^X][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") + (value.length > limit ? "\n[display truncated]" : "");
}
const one = (text: string) => displayText(text, 256).replace(/\s+/g, " ");
const running = (v: WorkerView) => v.state === "running";
function elapsed(v: WorkerView, now: number) {
	const start = Date.parse(v.started), end = v.finished ? Date.parse(v.finished) : now;
	const s = Math.max(0, Math.floor((end - start) / 1000));
	return Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "?";
}
const row = (v: WorkerView, now: number) => `${one(v.id)} ${one(v.agent)} ${one(v.state)} · ${one(v.model)} ${one(v.thinking)} · ${elapsed(v, now)} · ↑${v.inputTokens} ↓${v.outputTokens}${v.currentTool ? ` · ${one(v.currentTool)}` : ""}`;
export function renderWorkerPanel(views: WorkerView[], hint: boolean, theme: Theme, width: number, now = Date.now()): string[] {
	if (width <= 0 || !views.length) return [];
	const active = views.filter(v => !["succeeded", "cancelled"].includes(v.state));
	const lines = active.slice(0, 6).map(v => theme.fg(running(v) ? "accent" : "warning",
		`${running(v) ? "⠋" : "?"} ${one(v.agent)} ${one(v.id)} ${one(v.task).slice(0, 36)} · ${one(v.model)} ${one(v.thinking)} ${elapsed(v, now)} ↑${v.inputTokens} ↓${v.outputTokens}${v.currentTool ? ` · ${one(v.currentTool)}` : ""}`));
	if (active.length > 6) lines.push(theme.fg("muted", "… more: /tasks"));
	if (hint) lines.push(theme.fg("muted", "/tasks to see workers"));
	return lines.map(line => truncateToWidth(line, width, ""));
}
function describe(value: unknown): string {
	let budget = 64;
	function visit(v: unknown, depth: number): string {
		if (--budget < 0 || depth > 3) return "…";
		if (typeof v === "string") return displayText(v, 256);
		if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
		if (Array.isArray(v)) return "[" + v.slice(0, 8).map(x => visit(x, depth + 1)).join(", ") + "]";
		if (typeof v === "object") {
			const fields: string[] = [];
			for (const k in v) {
				if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
				fields.push(`${one(k)}: ${visit((v as Record<string, unknown>)[k], depth + 1)}`);
				if (fields.length === 8 || budget < 0) break;
			}
			return "{" + fields.join(", ") + "}";
		}
		return "[unsupported]";
	}
	return visit(value, 0);
}
export function transcriptText(v: WorkerView, detail: number): string {
	const chunks: string[] = [], live: string[] = [];
	let used = 0, clipped = v.messages.length > 96;
	function add(text: string, target = chunks) {
		const room = 32768 - used;
		if (text.length > room) clipped = true;
		if (room <= 0 || !text) return;
		const part = text.slice(0, room); target.push(part); used += part.length + 2;
	}
	add(displayText(v.error), live);
	if (detail === 2 && v.partialThinking) add(`### Thinking (live)\n${displayText(v.partialThinking)}`, live);
	if (v.partialText) add(`### Assistant (live)\n${displayText(v.partialText)}`, live);
	for (let i = v.messages.length - 1; i >= Math.max(0, v.messages.length - 96); i--) {
		if (used >= 32768) { clipped = true; break; }
		const m = v.messages[i], tool = m.role === "toolResult" || !!m.toolName;
		if (tool && detail === 0) continue;
		const parts = [tool ? `Tool ${one(m.toolName ?? "result")}${m.isError ? " — error" : ""}` : `### ${one(m.role)}`];
		if (m.errorMessage) parts.push(displayText(m.errorMessage));
		if (typeof m.content === "string") { if (!tool || detail === 2) parts.push(displayText(m.content)); }
		else if (Array.isArray(m.content)) {
			for (const raw of m.content.slice(0, 32)) {
				if (!raw || typeof raw !== "object") continue;
				const b = raw as Record<string, unknown>;
				if (b.type === "text" && (!tool || detail === 2)) parts.push(displayText(b.text));
				if (b.type === "thinking" && detail === 2) parts.push(`Thinking:\n${displayText(b.thinking)}`);
				if (b.type === "toolCall" && detail >= 1) {
					parts.push(`Tool call: ${one(typeof b.name === "string" ? b.name : "?")}`);
					if (detail === 2) parts.push(describe(b.arguments));
				}
			}
		} else if (detail === 2) parts.push(describe(m.content));
		add(parts.join("\n\n"));
	}
	return (clipped ? "[Older content omitted by display limits]\n\n" : "") + chunks.reverse().join("\n\n") + "\n\n" + live.join("\n\n");
}
// Manual import preview is read-only and separate from the steer/resume transcript input.
export async function showImportPreview(ctx: ExtensionContext, value: string): Promise<boolean> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return false;
	const safe = value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
	return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
		let top = 0, page = 1, width = -1, lines: string[] = [], closed = false;
		const close = (reviewed: boolean) => { if (!closed) { closed = true; done(reviewed); } };
		const content = new Text(safe, 0, 0);
		return { dispose() { close(false); }, invalidate() { width = -1; content.invalidate(); }, handleInput(data: string) {
			if (matchesKey(data, "escape") || matchesKey(data, "q")) { close(false); return; }
			if (matchesKey(data, "enter")) { close(true); return; }
			if (matchesKey(data, "pageUp")) top = Math.max(0, top - page);
			if (matchesKey(data, "pageDown")) top = Math.min(Math.max(0, lines.length - page), top + page);
			if (matchesKey(data, "up")) top = Math.max(0, top - 1);
			if (matchesKey(data, "down")) top = Math.min(Math.max(0, lines.length - page), top + 1);
			if (matchesKey(data, "home")) top = 0;
			if (matchesKey(data, "end")) top = Math.max(0, lines.length - page);
			tui.requestRender();
		}, render(w: number) {
			if (w <= 0) return [];
			if (width !== w) { lines = content.render(w); width = w; }
			page = Math.max(1, Math.min(30, tui.terminal.rows - 4)); top = Math.min(top, Math.max(0, lines.length - page));
			return [theme.fg("accent", "Owned-file import preview"), ...lines.slice(top, top + page),
				theme.fg("muted", "↑↓ PgUp/PgDn Home/End · Enter reviewed · Esc/q cancel")].map(l => truncateToWidth(l, w, ""));
		} };
	});
}
export async function showTasks(ctx: ExtensionContext, actions: WorkerUIActions): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		let selected: string | undefined, opened: string | undefined;
		let detail = 0, top = 0, page = 1, tail = true, dirty = true, closed = false, busy = false, focus = false;
		let lines: string[] = [], cachedWidth = -1, notice = "";
		let cachedMessages: WorkerView["messages"] | undefined, cachedPartial: string | undefined, cachedThinking: string | undefined, cachedError: string | undefined;
		const input = new Input();
		const redraw = () => { if (!closed) tui.requestRender(); };
		const unsubscribe = actions.subscribe(redraw);
		const close = () => { if (!closed) { closed = true; unsubscribe(); done(); } };
		async function act(operation: () => Promise<void>, submitted?: string) {
			if (busy || closed) return;
			busy = true; notice = ""; tui.requestRender();
			try {
				await operation();
				if (submitted !== undefined && input.getValue() === submitted) input.setValue("");
			} catch (error) { notice = displayText(error instanceof Error ? error.message : String(error), 256); }
			finally { busy = false; redraw(); }
		}
		input.onSubmit = text => { if (opened && text.trim() && !busy) { const id = opened; void act(() => actions.submit(id, text), text); } };
		const component: Component & Focusable & { dispose(): void } = {
			get focused() { return focus; },
			set focused(value) { focus = value; input.focused = value && !!opened; },
			dispose() { if (!closed) { closed = true; unsubscribe(); } },
			invalidate() { dirty = true; input.invalidate(); },
			handleInput(data) {
				if (matchesKey(data, "escape") || (matchesKey(data, "q") && (!opened || input.getValue() === ""))) { close(); return; }
				if (opened) {
					if (matchesKey(data, "ctrl+o")) { detail = (detail + 1) % 3; dirty = true; }
					else if (matchesKey(data, "pageUp")) { top = Math.max(0, top - page); tail = false; }
					else if (matchesKey(data, "pageDown")) { top = Math.min(Math.max(0, lines.length - page), top + page); tail = top >= Math.max(0, lines.length - page); }
					else if (matchesKey(data, "end")) tail = true;
					else input.handleInput(data);
				} else {
					const views = actions.list(); let index = Math.max(0, views.findIndex(v => v.id === selected));
					if (matchesKey(data, "up")) index = Math.max(0, index - 1);
					else if (matchesKey(data, "down")) index = Math.min(views.length - 1, index + 1);
					else if (matchesKey(data, "enter") && views[index]) { opened = views[index].id; tail = true; dirty = true; input.focused = focus; }
					else if (matchesKey(data, "x") && views[index] && running(views[index])) { const id = views[index].id; void act(() => actions.cancel(id)); }
					selected = views[index]?.id;
				}
				tui.requestRender();
			},
			render(width) {
				if (width <= 0) return [];
				const theme = ctx.ui.theme, fit = (s: string) => truncateToWidth(s, width, ""), views = actions.list();
				page = Math.max(1, Math.min(24, tui.terminal.rows - 7));
				const status = fit(theme.fg("muted", notice || (busy ? "Working…" : "")));
				if (!opened) {
					let index = views.findIndex(v => v.id === selected);
					if (index < 0) { index = 0; selected = views[0]?.id; }
					const start = Math.max(0, index - page + 1);
					return [fit(theme.fg("accent", "Tasks · ↑↓ Enter transcript · x stop running")),
						...views.slice(start, start + page).map(v => fit(theme.fg(v.id === selected ? "accent" : "muted", `${v.id === selected ? "> " : "  "}${row(v, Date.now())} · ${one(v.task)}`))),
						...(!views.length ? [fit("No tasks yet")] : []), status, fit(theme.fg("muted", "Esc/q close"))];
				}
				const v = views.find(view => view.id === opened);
				if (dirty || cachedWidth !== width || cachedMessages !== v?.messages || cachedPartial !== v?.partialText || cachedThinking !== v?.partialThinking || cachedError !== v?.error) {
					lines = new Markdown(v ? transcriptText(v, detail) : "Task no longer available.", 0, 0, getMarkdownTheme()).render(width).map(fit);
					dirty = false; cachedWidth = width; cachedMessages = v?.messages; cachedPartial = v?.partialText; cachedThinking = v?.partialThinking; cachedError = v?.error;
				}
				const max = Math.max(0, lines.length - page); top = tail ? max : Math.min(top, max);
				return [fit(theme.fg("accent", v ? row(v, Date.now()) : one(opened))), ...lines.slice(top, top + page),
					fit(theme.fg("muted", `${["text", "tools", "full"][detail]} · Ctrl+O · PgUp/PgDn · End tail`)), status,
					fit(theme.fg("muted", v && running(v) ? "Steer · Enter send · Esc close" : "Resume · Enter send · Esc close")), ...input.render(width).map(fit)];
			},
		};
		return component;
	});
}
