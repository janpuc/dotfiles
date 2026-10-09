// Deterministic effect classification for the Personal approval gate (docs/pi-personal-approvals-design.md).
// Pure: no I/O. Targets that only execution can reveal (push URL, cluster, gh repo) are listed in
// `unresolved` for the gate to resolve. Static parsing cannot see inside scripts, hooks, aliases or
// interpreter programs, nor expand variables and globs; those limits are documented, not hidden.
import { basename, dirname, join, resolve } from "node:path";

export type EffectClass = "local-destructive" | "external" | "disclosure" | "system" | "secret" | "opaque";
export interface Effect {
	class: EffectClass;
	op: string;
	target: Record<string, string>;
	unresolved?: string[];
	segment: string;
}
export interface ClassifyContext {
	cwd: string;
	home: string;
	projectRoot: string;
	tempDirs?: string[];
	realpath?: (p: string) => string;
	env?: Record<string, string | undefined>;
	/** Compare paths case-insensitively (default on macOS, whose APFS volumes usually are). */
	caseInsensitive?: boolean;
}

interface Token { value: string; raw: string; kind: "word" | "op" | "redir"; subs: string[]; start: number; end: number; issues?: string[]; heredocBody?: string }
const assignment = /^[A-Za-z_][A-Za-z_0-9]*=/;
const disposable = new Set(["node_modules", "dist", "build", "target", "coverage", ".cache", "__pycache__", ".pytest_cache", ".next", ".turbo"]);
// Templates hold names, not values; reading or editing them is routine.
const envTemplate = /^\.env\.(?:example|sample|template|dist)$/;
const fold = (p: string, ctx: ClassifyContext) => (ctx.caseInsensitive ?? process.platform === "darwin") ? p.toLowerCase() : p;
const inside = (path: string, root: string, ctx: ClassifyContext) => {
	const p = fold(path, ctx), r = fold(root, ctx).replace(/\/$/, "");
	return p === r || p.startsWith(r + "/");
};
function pathOf(text: string, ctx: ClassifyContext): string {
	const expanded = text === "~" ? ctx.home : text.startsWith("~/") ? ctx.home + text.slice(1) : text.replace(/^\$(?:HOME\b|\{HOME\})/, ctx.home);
	return (ctx.realpath ?? ((p: string) => p))(resolve(ctx.cwd, expanded));
}
// rm removes the directory entry itself: a symlink goes, its target stays.
function entryOf(text: string, ctx: ClassifyContext): string {
	const raw = text.replace(/(.)\/+$/, "$1");
	return join(pathOf(dirname(raw), ctx), basename(raw));
}
// Standard streams are where routine output goes (`2>/dev/null`); other devices stay outside.
const streams = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;
function bounded(path: string, ctx: ClassifyContext): boolean {
	return streams.test(path) || inside(path, pathOf(ctx.projectRoot, ctx), ctx) || temporary(path, ctx);
}
function temporary(path: string, ctx: ClassifyContext): boolean {
	return (ctx.tempDirs ?? ["/tmp", "/private/tmp", "/var/folders"]).some(dir => inside(path, pathOf(dir, ctx), ctx));
}
function secret(path: string, edit: boolean, ctx: ClassifyContext): boolean {
	const home = fold(pathOf(ctx.home, ctx), ctx), p = fold(path, ctx);
	const rel = inside(p, home, ctx) ? p.slice(home.length + 1) : "";
	return p.split("/").some(part => (part === ".env" || part.startsWith(".env.")) && !envTemplate.test(part)) || p.includes("credentials.fish")
		|| [".local/state/ai", ".config/op"].some(dir => rel === dir || rel.startsWith(dir + "/"))
		|| (edit ? rel === ".ssh" || rel.startsWith(".ssh/") : /^\.ssh\/id_[^/]+$/.test(rel))
		|| [".pi/agent/auth.json", ".pi/profiles/work/agent/auth.json", ".pi/agent/claude/.credentials.json", ".pi/profiles/work/agent/claude/.credentials.json", ".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml"].includes(rel);
}

// Heredocs are queued until the next newline, including inside command substitutions.
// Their bodies are data; only unquoted delimiters allow expansions to execute.
function tokenize(text: string, bodyOnly = false): Token[] {
	function scan(start: number, closing = false): { tokens: Token[]; end: number; closed: boolean } {
		const tokens: Token[] = [];
		const pending: { token: Token; tabs: boolean; quoted: boolean }[] = [];
		let i = start, depth = 0, delimiter: { tabs: boolean } | undefined;
		function expansion(subs: string[], issues: string[]): string {
			const begin = i;
			if (text[i] === "`") {
				i++; const bodyStart = i;
				while (i < text.length && text[i] !== "`") { if (text[i] === "\\") i++; i++; }
				const body = text.slice(bodyStart, i);
				subs.push(body);
				if (body.includes("\\")) issues.push("escaped backtick substitution");
				if (i < text.length) i++; else issues.push("unterminated substitution");
			} else {
				if (text.slice(i, i + 3) === "$((") issues.push("arithmetic expansion");
				const nested = scan(i + 2, true);
				subs.push(text.slice(i + 2, nested.closed ? nested.end - 1 : nested.end));
				i = nested.end;
				if (!nested.closed) issues.push("unterminated substitution");
			}
			return text.slice(begin, i);
		}
		function bodies() {
			for (const { token, tabs, quoted } of pending.splice(0)) {
				let body = "", found = false;
				while (i < text.length) {
					let line = "";
					do {
						const end = text.indexOf("\n", i), next = end < 0 ? text.length : end;
						line += text.slice(i, next); i = end < 0 ? next : next + 1;
						// Unquoted backslash-newline is removed before delimiter matching.
						const slashes = line.match(/\\+$/)?.[0].length ?? 0;
						if (quoted || end < 0 || slashes % 2 === 0) break;
						line = line.slice(0, -1);
					} while (i < text.length);
					if (tabs) line = line.replace(/^\t+/, "");
					if (line === token.value) { found = true; break; }
					body += line + "\n";
				}
				token.heredocBody = body;
				if (!found) (token.issues ??= []).push("unterminated heredoc");
				if (!quoted) {
					const expansions = heredocExpansions(body);
					token.subs.push(...expansions.subs);
					(token.issues ??= []).push(...expansions.issues);
				}
			}
		}
		if (bodyOnly && !closing) {
			const subs: string[] = [], issues: string[] = [];
			while (i < text.length) {
				if (text[i] === "\\" && /[\$`\\\n]/.test(text[i + 1] ?? "")) { i += 2; continue; }
				if (text.slice(i, i + 2) === "$(" || text[i] === "`") expansion(subs, issues);
				else i++;
			}
			return { tokens: [{ value: "", raw: "", kind: "word", subs, issues, start, end: i }], end: i, closed: true };
		}
		while (i < text.length) {
			if (/[ \t\r]/.test(text[i])) { i++; continue; }
			if (text[i] === "#" && !delimiter) { while (i < text.length && text[i] !== "\n") i++; continue; }
			const begin = i;
			const redir = text.slice(i).match(/^(?:\d+|&)?(?:<<<|<<-|<<|>>|>\||>|<)(?:&(?:\d+|-))?/);
			if (redir) {
				if (delimiter) { tokens.at(-1)!.issues = ["missing heredoc delimiter"]; delimiter = undefined; }
				i += redir[0].length;
				const token: Token = { value: redir[0], raw: redir[0], kind: "redir", subs: [], start: begin, end: i };
				tokens.push(token);
				if (/^(?:\d+|&)?<<-?$/.test(token.value)) delimiter = { tabs: token.value.endsWith("-") };
				continue;
			}
			const op = text.slice(i).match(/^(?:&&|\|\||\|&|[;|&\n()])/);
			if (op) {
				if (delimiter) { tokens.at(-1)!.issues = ["missing heredoc delimiter"]; delimiter = undefined; }
				i += op[0].length;
				if (op[0] === ")" && closing && depth === 0 && !pending.length) return { tokens, end: i, closed: true };
				if (op[0] === "(") depth++;
				if (op[0] === ")") depth--;
				tokens.push({ value: op[0], raw: op[0], kind: "op", subs: [], start: begin, end: i });
				if (op[0] === "\n") bodies();
				continue;
			}
			let value = "", quote = "", quoted = false;
			const subs: string[] = [], issues: string[] = [];
			while (i < text.length) {
				const c = text[i];
				if (!quote && /[\s;|&()<>]/.test(c)) break;
				if (c === "\\" && quote !== "'") {
					const next = text[i + 1];
					if (quote === '"' && next && !/[\$`"\\\n]/.test(next)) { value += c; i++; }
					else { if (next && next !== "\n") value += next; i += 2; quoted = true; }
					continue;
				}
				if (c === quote) { quote = ""; i++; continue; }
				if (!quote && (c === "'" || c === '"')) { quote = c; quoted = true; i++; continue; }
				if (!delimiter && quote !== "'" && (text.slice(i, i + 2) === "$(" || c === "`")) { value += expansion(subs, issues); continue; }
				value += c; i++;
			}
			if (quote) issues.push("unterminated quote");
			const token: Token = { value, raw: text.slice(begin, i), kind: "word", subs, start: begin, end: i, issues };
			tokens.push(token);
			if (delimiter) { pending.push({ token, tabs: delimiter.tabs, quoted }); delimiter = undefined; }
		}
		if (delimiter) tokens.at(-1)!.issues = ["missing heredoc delimiter"];
		for (const { token } of pending) (token.issues ??= []).push("unterminated heredoc");
		return { tokens, end: i, closed: !closing };
	}
	return scan(0).tokens;
}

function heredocExpansions(body: string): { subs: string[]; issues: string[] } {
	// Quotes in the body are data, but quotes inside a substitution keep shell semantics.
	const tokens = tokenize(body, true);
	const issues = tokens.flatMap(t => t.issues ?? []);
	if (/\$\{(?![A-Za-z_][A-Za-z_0-9]*\})/.test(body)) issues.push("unsupported heredoc parameter expansion");
	return { subs: tokens.flatMap(t => t.subs), issues };
}

function option(args: string[], ...names: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) for (const name of names) {
		if (args[i] === name) return args[i + 1];
		if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
		if (name.length === 2 && args[i].startsWith(name) && args[i].length > 2) return args[i].slice(2);
	}
	return undefined;
}
function positionals(args: string[], values: string[] = []): string[] {
	const out: string[] = []; let ended = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!ended && arg === "--") { ended = true; continue; }
		if (!ended && arg.startsWith("-")) { if (values.includes(arg)) i++; continue; }
		out.push(arg);
	}
	return out;
}
const has = (args: string[], ...flags: string[]) => args.some(a => flags.includes(a) || flags.some(f => f.startsWith("--") && a.startsWith(f + "=")));
const short = (args: string[], flag: string) => args.some(a => /^-[^-]/.test(a) && a.slice(1).includes(flag));
const hostOf = (text: string): string => {
	try { return new URL(text).hostname; } catch { return ""; }
};

// Only an entire, simple assignment from literal mktemp syntax establishes a temp alias.
// The representative path is for classification, not an assertion of the generated filename.
function tempAssignment(token: Token, ctx: ClassifyContext): string | undefined {
	const match = token.raw.match(/^([A-Za-z_][A-Za-z_0-9]*)=(?:\$\(([^]*)\)|"\$\(([^]*)\)")$/);
	if (!match || token.issues?.length || token.subs.length !== 1) return;
	const parts = tokenize(match[2] ?? match[3]);
	if (parts.some(t => t.kind !== "word" || t.subs.length || t.issues?.length || /[$`\\]/.test(t.raw))) return;
	const words = parts.map(t => t.value);
	if (words.shift() !== "mktemp") return;
	let root = ctx.env?.TMPDIR ?? "/tmp", template: string | undefined, prefix = false;
	for (let i = 0; i < words.length; i++) {
		const arg = words[i];
		if (arg === "-d" || arg === "--directory" || arg === "-q" || arg === "--quiet") continue;
		if (arg === "-t" && !prefix && !template) { prefix = true; continue; }
		if (arg === "-p" && !prefix && !template) { root = words[++i]; if (!root) return; continue; }
		if (arg.startsWith("-") || template) return; // Includes -u/--dry-run and unknown options.
		template = arg;
	}
	if (prefix) { if (!template || !/^[A-Za-z0-9_.-]+$/.test(template)) return; }
	else if (template) {
		if (!/^[A-Za-z0-9_./-]*X{3,}$/.test(template)) return;
		// A bare template is relative to cwd unless -p was supplied.
		root = template.startsWith("/") ? dirname(template) : words.includes("-p") ? root : ctx.cwd;
	}
	if (!/^[A-Za-z0-9_./-]+$/.test(root)) return;
	const path = pathOf(root, ctx);
	if (!temporary(path, ctx)) return;
	return join(path, `.pi-mktemp-${match[1]}`);
}

function aliasValue(token: Token, aliases: Map<string, string>): string {
	const raw = token.raw.startsWith('"') && token.raw.endsWith('"') ? token.raw.slice(1, -1) : token.raw;
	const match = raw.match(/^\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})(\/[A-Za-z0-9_./-]*)?$/);
	const path = match && aliases.get(match[1] ?? match[2]);
	return path ? path + (match![3] ?? "") : token.value;
}

export function classifyBash(command: string, ctx: ClassifyContext): Effect[] {
	const effects: Effect[] = [];
	let current: ClassifyContext = { ...ctx, env: { ...ctx.env } };
	const stack: { ctx: ClassifyContext; aliases: Map<string, string>; assigned: Set<string> }[] = [];
	const tokens = tokenize(command);
	// No path proof across conditionals, pipelines, loops or functions. These need dataflow
	// analysis, not a guess that a possibly skipped assignment ran.
	const linear = !tokens.some(t => t.kind === "op" && ![";", "\n", "(", ")"].includes(t.value)
		|| t.kind === "word" && /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|\{|\})$/.test(t.value))
		&& !tokens.some((t, i) => t.value === "(" && tokens[i + 1]?.value === "(");
	let aliasesAllowed = linear;
	let aliases = new Map<string, string>(), assigned = new Set<string>();
	let segment: Token[] = [];
	function flush() {
		if (!segment.length) return;
		const text = command.slice(segment[0].start, segment[segment.length - 1].end).trim();
		for (const token of segment) {
			for (const sub of token.subs) effects.push(...classifyBash(sub, current));
			for (const reason of token.issues ?? []) effects.push({ class: "opaque", op: "shell.parse", target: { reason }, segment: text });
		}
		const wordTokens = segment.filter(t => t.kind === "word");
		const cmd = wordTokens.find(t => !assignment.test(t.value))?.value;
		if (segment.some(t => t.issues?.length || /\$\{(?![A-Za-z_][A-Za-z_0-9]*\})|\$\(\(/.test(t.raw))
			|| wordTokens.some(t => ["read", "readarray", "mapfile", "unset", "export", "declare", "typeset", "local", "readonly", "printf", "let", "eval", "source", ".", "trap", "set", "getopts", "wait"].includes(basename(t.value)))) { aliases.clear(); aliasesAllowed = false; }
		const updates: [string, string | undefined][] = [];
		for (const token of wordTokens) {
			const name = token.value.match(/^([A-Za-z_][A-Za-z_0-9]*)(?:\[[^\]]*\])?\+?=/)?.[1];
			if (!name) break;
			const path = aliasesAllowed && !cmd && segment.length === 1 && !assigned.has(name) ? tempAssignment(token, current) : undefined;
			aliases.delete(name); assigned.add(name); updates.push([name, path]);
		}
		if (cmd && ["bash", "sh", "zsh", "dash", "python", "python3", "node", "ruby", "perl", "php"].includes(basename(cmd)) && segment.some(t => t.kind === "redir" && t.value.includes("<<")))
			effects.push({ class: "opaque", op: "interpreter.heredoc", target: { interpreter: basename(cmd) }, segment: text });
		const words: string[] = [];
		for (let i = 0; i < segment.length; i++) {
			const token = segment[i];
			if (token.kind === "redir") {
				if (!token.value.includes(">&") && !token.value.includes("<&")) {
					const dest = segment[++i];
					if (dest && !token.value.includes("<<")) fileEffect(aliasValue(dest, aliases), token.value.includes(">"), current, text, effects);
				}
			} else words.push(aliasValue(token, aliases));
		}
		const before = effects.length;
		current = classifySimple(words, current, text, effects, segment.flatMap(t => t.heredocBody === undefined ? [] : [t.heredocBody]));
		for (const [name, path] of updates) if (path) aliases.set(name, path);
		// Floor for references parsing missed (variables, odd quoting); one effect per item, so a
		// single /secret-once still covers a read the parser did recognise.
		if (/credentials\.fish|\.config\/op\/|\.ssh\/id_|\.local\/state\/ai/.test(text) && !effects.slice(before).some((e) => e.class === "secret"))
			effects.push({ class: "secret", op: "secret.tool", target: { command: text }, segment: text });
		segment = [];
	}
	for (const token of tokens) {
		if (token.kind !== "op") { segment.push(token); continue; }
		flush();
		if (token.value === "(") {
			stack.push({ ctx: current, aliases, assigned }); current = { ...current, env: { ...current.env } };
			aliases = new Map(aliases); assigned = new Set(assigned);
		}
		if (token.value === ")") {
			const saved = stack.pop();
			if (saved) { current = saved.ctx; aliases = saved.aliases; assigned = saved.assigned; }
		}
	}
	flush();
	return effects;
}

function fileEffect(text: string, edit: boolean, ctx: ClassifyContext, segment: string, effects: Effect[]): void {
	const path = pathOf(text, ctx);
	if (secret(path, edit, ctx)) effects.push({ class: "secret", op: edit ? "secret.edit" : "secret.read", target: { path }, segment });
	else if (edit && !bounded(path, ctx)) effects.push({ class: "local-destructive", op: "fs.write-outside", target: { path }, segment });
}

function classifySimple(words: string[], ctx: ClassifyContext, segment: string, effects: Effect[], stdinBodies: string[] = []): ClassifyContext {
	let local = { ...ctx, env: { ...ctx.env } };
	while (assignment.test(words[0] ?? "")) {
		const word = words.shift()!; const at = word.indexOf("="); local.env[word.slice(0, at)] = word.slice(at + 1);
	}
	const executable = words[0]; if (!executable) return local;
	const cmd = basename(executable), args = words.slice(1);
	const emit = (cls: EffectClass, op: string, target: Record<string, string> = {}, unresolved?: string[]) => {
		const effect: Effect = { class: cls, op, target, segment };
		if (unresolved?.length) effect.unresolved = unresolved;
		effects.push(effect);
	};
	const reenter = (rest: string[]) => classifySimple(rest, local, rest.join(" "), effects, stdinBodies);
	if (["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "timeout", "xargs"].includes(cmd)) {
		if (cmd === "sudo" || cmd === "doas") emit("system", "system.privilege", { command: cmd });
		if (cmd === "command" && has(args, "-v", "-V")) return ctx;
		let i = 0;
		const valued: Record<string, string[]> = {
			env: ["-u", "--unset", "-C", "--chdir"], sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-D", "--user", "--group", "--chdir"], doas: ["-u"],
			exec: ["-a"], time: ["-o", "--output", "-f", "--format"], nice: ["-n", "--adjustment"], timeout: ["-s", "--signal", "-k", "--kill-after"],
			xargs: ["-I", "-n", "-P", "-s", "-E", "-L", "-d", "-a", "--delimiter", "--arg-file", "--replace", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--eof"],
		};
		while (i < args.length) {
			const a = args[i];
			if (a === "--") { i++; break; }
			if (cmd === "env" && assignment.test(a)) { const at = a.indexOf("="); local.env[a.slice(0, at)] = a.slice(at + 1); i++; continue; }
			if (!a.startsWith("-")) break;
			if (cmd === "env" && (a === "-i" || a === "--ignore-environment")) local.env = {};
			if (cmd === "env" && (a === "-u" || a === "--unset")) delete local.env[args[i + 1]];
			if (cmd === "env" && (a === "-C" || a === "--chdir")) local.cwd = pathOf(args[i + 1] ?? ".", local);
			i += (valued[cmd] ?? []).includes(a) ? 2 : 1;
		}
		if (cmd === "timeout") i++;
		reenter(args.slice(i)); return ctx;
	}
	if (["bash", "sh", "zsh", "dash"].includes(cmd)) {
		const i = args.findIndex(a => /^-[^-]*c/.test(a));
		if (i >= 0 && args[i + 1] !== undefined) effects.push(...classifyBash(args[i + 1], local));
		// Conservatively reparse stdin attached to a shell, including quoted delimiters
		// and env/command/sudo wrappers. Option values (-o errexit, -O extglob, --rcfile)
		// must never be mistaken for script operands and suppress effect detection.
		// A script/-c that merely consumes data can over-report; do not guess its semantics.
		for (const body of stdinBodies) effects.push(...classifyBash(body, local));
		return ctx;
	}
	// Opaque interpreter programs still retain the explicit secret-reference floor.
	// Consuming heredoc bodies must not hide literal credential paths previously visible
	// to the classifier. Do not turn their ordinary text into shell effects.
	if (["python", "python3", "node", "ruby", "perl", "php", "deno", "bun"].includes(cmd)) {
		for (const body of stdinBodies) {
			const before = effects.length;
			for (const token of tokenize(body).filter(t => t.kind === "word")) {
				const value = assignment.test(token.value) ? token.value.slice(token.value.indexOf("=") + 1) : token.value;
				fileEffect(value, false, local, segment, effects);
			}
			if (/credentials\.fish|\.config\/op\/|\.ssh\/id_|\.local\/state\/ai/.test(body) && !effects.slice(before).some(e => e.class === "secret"))
				emit("secret", "secret.tool", { command: body });
		}
	}
	if (cmd === "eval") { effects.push(...classifyBash(args.join(" "), local)); return ctx; }
	if (cmd === "cd" || cmd === "pushd") return { ...ctx, cwd: pathOf(positionals(args)[0] ?? ctx.home, ctx) };
	// find runs its -exec commands and deletes its matches: re-enter the former, classify the latter
	// like a recursive rm of each root.
	if (cmd === "find") {
		let i = 0;
		const roots: string[] = [];
		while (i < args.length && /^-[HLP]$/.test(args[i])) i++;
		while (i < args.length && !/^[-(!]/.test(args[i])) roots.push(args[i++]);
		for (let j = i; j < args.length; j++) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[j])) continue;
			const end = args.findIndex((a, k) => k > j && (a === ";" || a === "+"));
			reenter(args.slice(j + 1, end < 0 ? undefined : end));
			if (end < 0) break;
			j = end;
		}
		if (has(args, "-delete")) for (const root of roots.length ? roots : ["."]) {
			const path = pathOf(root, local);
			if (!temporary(path, local) && !(inside(path, pathOf(local.projectRoot, local), local) && disposable.has(basename(path)))) emit("local-destructive", "fs.delete", { path });
		}
		return ctx;
	}

	let destinations: string[] = [];
	if (cmd === "dd") destinations = args.filter(a => a.startsWith("of=")).map(a => a.slice(3));
	else if (cmd === "tee" || cmd === "truncate") destinations = positionals(args, ["-s", "--size", "-r", "--reference"]);
	else if (["mv", "cp", "ln"].includes(cmd)) {
		const pos = positionals(args, ["-t", "--target-directory", "-S", "--suffix"]);
		const dest = option(args, "-t", "--target-directory") ?? (pos.length > 1 ? pos.at(-1) : undefined);
		if (dest) destinations = [dest];
	}
	// Arguments may expose secrets even when the executable itself is unfamiliar.
	for (let arg of args) {
		if (arg.startsWith("-") && arg.includes("=")) arg = arg.slice(arg.indexOf("=") + 1);
		else if (["curl", "wget"].includes(cmd) && /^-[dFT].+/.test(arg)) arg = arg.slice(2);
		if (arg.startsWith("-") || !arg || destinations.includes(arg) || arg.startsWith("of=")) continue;
		const uploadFile = ["curl", "wget"].includes(cmd) ? arg.match(/(?:^|=)@([^;]+)(?:;.*)?$/)?.[1] : undefined;
		const candidate = uploadFile ?? (arg.startsWith("@") ? arg.slice(1) : arg.startsWith("if=") ? arg.slice(3) : arg);
		const path = pathOf(candidate, local);
		const edit = cmd === "rm" || cmd === "mv" || (cmd === "sed" && args.some(a => /^-i/.test(a)));
		if (secret(path, edit, local)) emit("secret", edit ? "secret.edit" : "secret.read", { path });
	}
	for (const dest of destinations) fileEffect(dest, true, local, segment, effects);
	if (cmd === "op" || (cmd === "security" && ["find-generic-password", "find-internet-password", "dump-keychain", "export"].includes(args[0]))) emit("secret", "secret.tool", { command: words.join(" ") });
	if (["python", "python3", "node", "ruby", "perl", "php", "deno", "bun"].includes(cmd) && (has(args, "-c", "-e", "--eval") || args[0] === "eval")) emit("opaque", "interpreter.inline", { interpreter: cmd });

	if (cmd === "git") {
		const configs: string[] = [];
		let i = 0, dir = local.env.GIT_WORK_TREE ? pathOf(local.env.GIT_WORK_TREE, local) : local.cwd;
		while (i < args.length && args[i].startsWith("-")) {
			if (args[i] === "-C") { dir = pathOf(args[i + 1] ?? ".", { ...local, cwd: dir }); i += 2; }
			else if (args[i].startsWith("-C")) { dir = pathOf(args[i].slice(2), { ...local, cwd: dir }); i++; }
			else if (args[i] === "--work-tree" || args[i].startsWith("--work-tree=")) {
				dir = pathOf(args[i].includes("=") ? args[i].slice(12) : args[i + 1] ?? ".", { ...local, cwd: dir });
				i += args[i].includes("=") ? 1 : 2;
			}
			else if (args[i] === "-c") { configs.push(args[i + 1] ?? ""); i += 2; }
			else if (args[i].startsWith("-c")) { configs.push(args[i].slice(2)); i++; }
			else if (["--git-dir", "--namespace"].includes(args[i])) i += 2;
			else i++;
		}
		dir = pathOf(dir, local);
		const verb = args[i], rest = args.slice(i + 1);
		if (verb === "push") {
			const pos = positionals(rest, ["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
			const explicitRemote = option(rest, "--repo");
			const refs = explicitRemote ? pos : pos.slice(1);
			// Selectors change push scope even when no literal refspec was supplied.
			const selectors = ["--all", "--tags", "--mirror"].filter(flag => has(rest, flag));
			emit("external", "git.push", { dir, config: configs.length || Object.keys(local.env).some(k => k.startsWith("GIT_CONFIG_")) ? JSON.stringify([configs, Object.keys(local.env).filter(k => k.startsWith("GIT_CONFIG_")).sort().map(k => [k, local.env[k]])]) : "", remote: explicitRemote ?? pos[0] ?? "", refs: [...selectors, ...refs].join(" "), force: has(rest, "--force", "--force-with-lease", "--force-if-includes", "--mirror") || short(rest, "f") || refs.some(r => r.startsWith("+")) ? "yes" : "no", delete: has(rest, "--delete", "--mirror") || short(rest, "d") || refs.some(r => r.startsWith(":")) ? "yes" : "no" }, ["pushUrl"]);
		}
		if ((verb === "reset" && has(rest, "--hard")) || (verb === "clean" && (short(rest, "f") || has(rest, "--force")))
			|| (verb === "checkout" && (has(rest, "--", "--force") || short(rest, "f") || rest.includes(".")))
			|| (verb === "restore" && !has(rest, "--staged") && !short(rest, "S"))
			|| (verb === "switch" && (has(rest, "--discard-changes", "--force") || short(rest, "f")))
			|| (verb === "stash" && ["drop", "clear"].includes(rest[0]))) emit("local-destructive", "git.discard", { dir });
		if (verb === "branch" && (short(rest, "D") || ((has(rest, "--delete") || short(rest, "d")) && (has(rest, "--force") || short(rest, "f"))))) emit("local-destructive", "git.branch-delete", { dir });
	}
	if (cmd === "rm") for (const arg of positionals(args)) {
		const path = entryOf(arg, local), recursive = has(args, "--recursive") || short(args, "r") || short(args, "R");
		if (!temporary(path, local) && (recursive ? !(inside(path, pathOf(local.projectRoot, local), local) && disposable.has(basename(path))) : !bounded(path, local))) emit("local-destructive", "fs.delete", { path });
	}
	if (cmd === "gh") {
		const pos = positionals(args, ["--repo", "-R", "--hostname", "-X", "--method", "-f", "-F", "--field", "--raw-field", "--input", "-H", "--header"]);
		const writes: Record<string, string[]> = {
			pr: ["create", "merge", "close", "reopen", "comment", "edit", "review", "ready"], issue: ["create", "close", "reopen", "comment", "edit", "delete"], release: ["create", "delete", "upload", "edit"], repo: ["create", "delete", "archive", "edit", "rename", "fork", "sync"], workflow: ["run", "enable", "disable"], run: ["cancel", "rerun", "delete"], secret: ["set", "delete"], variable: ["set", "delete"], label: ["create", "edit", "delete"], gist: ["create", "edit", "delete"],
		};
		// The repository is the approval's identity; without -R it is the checkout's, resolved later.
		const repo = option(args, "-R", "--repo") ?? "";
		if (writes[pos[0]]?.includes(pos[1])) emit("external", "gh.write", { subcommand: pos.slice(0, 2).join(" "), repo }, repo ? undefined : ["repo"]);
		if (pos[0] === "api") {
			const fields = args.some(a => /^-(?:f|F)/.test(a) || /^(--field|--raw-field|--input)(=|$)/.test(a));
			const method = (option(args, "-X", "--method") ?? (fields ? "POST" : "GET")).toUpperCase();
			if (method !== "GET" || fields) emit("external", "gh.api", { method, endpoint: pos[1] ?? "" });
		}
	}
	// Global options may precede the verb (`npm -w pkg publish`, `docker --context x push`).
	const verbs = positionals(args, ["-w", "--workspace", "--registry", "-p", "--package", "-H", "--host", "--context", "-c", "--config", "-t", "--tag", "-f", "--file", "--platform", "--build-arg", "--target"]);
	if ((["npm", "pnpm", "yarn", "bun", "cargo"].includes(cmd) && verbs[0] === "publish") || (cmd === "twine" && verbs[0] === "upload") || (["gem", "docker", "podman"].includes(cmd) && verbs[0] === "push")
		|| (["docker", "podman"].includes(cmd) && (verbs[0] === "build" || (verbs[0] === "buildx" && verbs[1] === "build")) && has(args, "--push"))) emit("external", "pkg.publish", { command: words.join(" ") });
	if (cmd === "kubectl") {
		const pos = positionals(args, ["--context", "--namespace", "-n", "--kubeconfig", "--server", "-s", "--token", "-f", "--filename", "-o", "--output"]);
		const verb = pos[0];
		if ((["get", "describe"].includes(verb) && /^(secrets?)(?:[/.]|$)/.test(pos[1] ?? "")) || verb === "view-secret") emit("secret", "secret.tool", { command: words.join(" ") });
		if (["apply", "create", "delete", "patch", "edit", "replace", "scale", "rollout", "drain", "cordon", "uncordon", "label", "annotate", "set", "expose", "run", "exec", "cp", "taint"].includes(verb)) {
			const context = option(args, "--context") ?? "", target: Record<string, string> = { verb, context, namespace: option(args, "--namespace", "-n") ?? "", server: option(args, "--server", "-s") ?? "" };
			const kubeconfig = option(args, "--kubeconfig") ?? local.env.KUBECONFIG;
			if (kubeconfig) target.kubeconfig = kubeconfig;
			emit("external", "kubectl.mutate", target, context ? undefined : ["cluster"]);
		}
	}
	// Cluster tools carry the same identity as kubectl: an approval names a cluster and namespace.
	const mutators: Record<string, [string[], string[]]> = {
		flux: [["reconcile", "suspend", "resume", "delete", "create", "bootstrap"], ["-n", "--namespace", "--context", "--kubeconfig", "--server", "--timeout"]],
		helm: [["install", "upgrade", "uninstall", "rollback", "delete"], ["-n", "--namespace", "--kube-context", "--kubeconfig", "--kube-apiserver"]],
		talosctl: [["apply-config", "patch", "upgrade", "upgrade-k8s", "reboot", "reset", "shutdown", "bootstrap", "edit"], ["-n", "--nodes", "-e", "--endpoints", "--talosconfig", "--context"]],
	};
	const mutator = mutators[cmd], mutating = mutator && positionals(args, mutator[1])[0];
	if (mutator && mutating && mutator[0].includes(mutating)) {
		const context = option(args, "--context", "--kube-context") ?? "";
		if (cmd === "talosctl") emit("external", "talosctl.mutate", { verb: mutating, context, nodes: option(args, "-n", "--nodes") ?? "" });
		else {
			const target: Record<string, string> = { verb: mutating, context, namespace: option(args, "-n", "--namespace") ?? "", server: option(args, "--server", "--kube-apiserver") ?? "" };
			const kubeconfig = option(args, "--kubeconfig") ?? local.env.KUBECONFIG;
			if (kubeconfig) target.kubeconfig = kubeconfig;
			emit("external", `${cmd}.mutate`, target, context ? undefined : ["cluster"]);
		}
	}
	if (["terraform", "tofu"].includes(cmd)) {
		const pos = positionals(args), chdir = option(args, "-chdir");
		if (["apply", "destroy", "import"].includes(pos[0]) || (pos[0] === "state" && ["rm", "mv", "push"].includes(pos[1])))
			emit("external", "terraform.mutate", { verb: pos.slice(0, pos[0] === "state" ? 2 : 1).join(" "), dir: chdir ? pathOf(chdir, local) : local.cwd });
	}
	if (cmd === "chezmoi") {
		// The verb and every option are part of what is approved (destroy is not apply; dropping
		// --exclude scripts runs scripts). Words are split by position and kept as JSON arrays, so
		// '/a /b' and /a /b stay different approvals.
		const values = ["-S", "--source", "-D", "--destination", "-c", "--config", "-W", "--working-tree", "--cache", "--persistent-state", "-o", "--output", "-x", "--exclude", "-i", "--include", "--override-data", "--override-data-file"];
		const pos: string[] = [], options: string[] = [], flags: string[] = [];
		for (let i = 0, ended = false; i < args.length; i++) {
			if (!ended && args[i] === "--") { ended = true; options.push(args[i]); }
			else if (!ended && args[i].startsWith("-")) { flags.push(args[i]); options.push(args[i]); if (values.includes(args[i]) && i + 1 < args.length) options.push(args[++i]); }
			else pos.push(args[i]);
		}
		if (["apply", "update", "purge", "destroy"].includes(pos[0]) || (pos[0] === "init" && has(flags, "--apply")))
			emit("external", "chezmoi.apply", { verb: pos[0], options: JSON.stringify(options), targets: JSON.stringify(pos.slice(1)) });
	}
	if (cmd === "just" && /^(kube|talos|bootstrap)/.test(positionals(args, ["-f", "--justfile", "-d", "--working-directory"])[0] ?? "")) emit("external", "cluster.recipe", { recipe: positionals(args)[0] });
	if (cmd === "ssh") emit("external", "net.ssh", { host: positionals(args, ["-p", "-l", "-i", "-F", "-o", "-J", "-L", "-R", "-D", "-S", "-b", "-c"])[0] ?? "" });
	if (cmd === "curl" || cmd === "wget") {
		const upload = cmd === "curl" ? args.some(a => /^--(?:data[^=]*|form[^=]*|upload-file|json)(=|$)/.test(a) || /^-[dFT]/.test(a)) : args.some(a => /^--(?:post-data|post-file|method|body-[^=]*)(=|$)/.test(a));
		const method = (option(args, "-X", "--request", "--method") ?? (has(args, "-I", "--head") ? "HEAD" : upload ? (has(args, "-T", "--upload-file") || args.some(a => /^-T./.test(a)) ? "PUT" : "POST") : "GET")).toUpperCase();
		if (upload || !["GET", "HEAD"].includes(method)) {
			const urls = args.filter(a => /^https?:\/\//.test(a)).concat(option(args, "--url") ?? []).filter(Boolean);
			for (const url of urls.length ? urls : [""]) emit("disclosure", "http.upload", { host: hostOf(url), method });
		}
	}
	if (["scp", "sftp", "rsync"].includes(cmd)) for (const arg of positionals(args, ["-e", "-i", "-P", "-p", "-o", "-F", "--rsh"])) {
		const remote = arg.match(/^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):/);
		if (remote) emit("disclosure", "net.copy", { host: remote[1] });
	}
	if (["nc", "ncat", "netcat", "socat"].includes(cmd)) {
		const pos = positionals(args, ["-p", "-s", "-w", "-i", "-e", "-c"]);
		const host = cmd === "socat" ? args.map(a => a.match(/^(?:TCP|UDP|TCP4|TCP6|UDP4|UDP6)(?:-CONNECT)?:([^:]+):/i)?.[1]).find(Boolean) : pos[0];
		if (host) emit("disclosure", "net.send", { host });
	}
	if (["brew", "apt", "apt-get", "dnf", "yum", "pacman", "port", "softwareupdate", "npm", "pnpm", "yarn"].includes(cmd)) {
		const verb = positionals(args)[0];
		const packageChange = cmd === "brew" ? ["install", "uninstall", "remove", "reinstall", "upgrade", "tap", "untap", "services", "link", "unlink"].includes(verb)
			: cmd === "softwareupdate" ? has(args, "-i", "--install")
			: ["npm", "pnpm", "yarn"].includes(cmd) ? ((has(args, "-g", "--global") && ["install", "i", "add"].includes(verb)) || (verb === "global" && ["add", "install"].includes(args[1])))
			: ["install", "remove", "uninstall", "purge", "reinstall", "upgrade", "update", "dist-upgrade", "full-upgrade", "autoremove"].includes(verb) || (cmd === "pacman" && (short(args, "S") || short(args, "R")));
		if (packageChange) emit("system", cmd === "brew" && verb === "services" ? "system.service" : "system.package", { command: words.join(" ") });
	}
	if ((cmd === "launchctl" && ["load", "unload", "bootstrap", "bootout", "enable", "disable", "kickstart", "remove"].includes(args[0])) || (cmd === "systemctl" && positionals(args)[0] && !/^(status|show|list-.*|cat|is-.*)$/.test(positionals(args)[0]))) emit("system", "system.service", { command: words.join(" ") });
	return ctx;
}

export function classifyTool(tool: string, input: Record<string, unknown> | undefined, ctx: ClassifyContext): Effect[] {
	if (tool === "bash") return classifyBash(typeof input?.command === "string" ? input.command : "", ctx);
	if (!["read", "grep", "find", "ls", "edit", "write"].includes(tool)) return [];
	const value = input?.path ?? input?.file_path ?? ".";
	const effects: Effect[] = [];
	fileEffect(typeof value === "string" ? value : ".", tool === "edit" || tool === "write", ctx, tool, effects);
	return effects;
}
