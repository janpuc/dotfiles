// Mirror of the organisation's Claude Code permission policy for Work Pi sessions, and the same
// engine for the Personal policy (~/.pi/shared/personal-policy.json): Claude Code rule syntax, but
// anything no rule covers is allowed, so only the listed risky actions ask or are refused.
//
// pi-claude-bridge has Claude Code relay Pi's tools, so Claude Code's own checks never see
// what those tools do, and the enterprise policy disables bypass mode. Pi therefore applies
// the org's managed rules itself, read from the Work Claude login's cached policy
// (remote-settings.json): deny blocks, ask and anything a Claude session would have to approve
// asks, allow runs. Pure functions only; index.ts does the I/O and the prompts.

import { dirname, isAbsolute, join, resolve } from "node:path";

export interface OrgPolicy {
	allow: string[];
	deny: string[];
	ask: string[];
	defaultMode?: string;
	managedRulesOnly: boolean;
	/** What happens to a command, edit or tool no rule covers: ask (Work, bypass mode off) or allow (Personal). */
	unlisted?: "ask" | "allow";
	/** How reasons name the policy. */
	label?: string;
}

/** The Personal policy file: `{ "deny": [...], "ask": [...] }` in Claude Code rule syntax. */
export function parsePersonalPolicy(raw: unknown): OrgPolicy {
	const list = (v: unknown, key: string) => {
		if (v === undefined) return [];
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${key} must be a list of rules`);
		return v as string[];
	};
	const p = raw as any;
	if (!p || typeof p !== "object") throw new Error("not an object");
	return { allow: [], deny: list(p.deny, "deny"), ask: list(p.ask, "ask"), managedRulesOnly: false, unlisted: "allow", label: "your Personal policy" };
}

export type Decision = { verdict: "allow" | "deny" | "ask"; rule?: string; reason: string };

export interface Approvals {
	/** Bash command prefixes approved for the rest of the session, e.g. "npm test". */
	bash: string[];
	/** Pi tools approved for the rest of the session, e.g. "edit", "write". */
	tools: string[];
}

/** Pull the permission block out of Claude Code's cached server-managed settings. */
export function parseOrgPolicy(remoteSettings: unknown): OrgPolicy {
	const p = (remoteSettings as any)?.permissions;
	if (!p || typeof p !== "object") throw new Error("no permissions block in the managed settings");
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	return {
		allow: list(p.allow),
		deny: list(p.deny),
		ask: list(p.ask),
		defaultMode: typeof p.defaultMode === "string" ? p.defaultMode : undefined,
		managedRulesOnly: (remoteSettings as any)?.allowManagedPermissionRulesOnly === true,
	};
}

type Rule = { tool: string; spec?: string; raw: string };

function parseRule(raw: string): Rule | undefined {
	const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s.exec(raw.trim());
	return m ? { tool: m[1], spec: m[2], raw } : undefined;
}

// --- Bash -------------------------------------------------------------------------------

/**
 * Split a shell command into the simple commands a rule must cover, the way Claude Code checks
 * compound commands. Best effort without a full parser: splitting too eagerly can only add
 * segments, which makes deny more likely to match and allow less likely, never the reverse.
 * Command substitutions are checked as commands of their own.
 */
export function commandSegments(command: string): string[] {
	const subs = [...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
	return [command, ...subs]
		// `&` splits only as a separator, not inside redirections like 2>&1 or &>.
		.flatMap((c) => c.split(/\|\||&&|\|&|[;|\n]|(?<![<>])&(?!>)|\$\(|\)|`/))
		.map((s) => s.trim().replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "").replace(/^(?:command|exec|time|nohup)\s+/, ""))
		.filter(Boolean);
}

/** `git status *` matches `git status` and `git status -s`; `*` elsewhere matches anything. */
function bashPattern(spec: string): RegExp {
	let s = spec.trim().replace(/:\*$/, " *");
	const optionalTail = s.endsWith(" *");
	if (optionalTail) s = s.slice(0, -2);
	const body = s.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${body}${optionalTail ? "(?:\\s.*)?" : ""}$`, "s");
}

function bashMatches(rule: Rule, segment: string): boolean {
	if (rule.tool !== "Bash") return false;
	if (rule.spec === undefined || rule.spec === "" || rule.spec === "*") return true;
	return bashPattern(rule.spec).test(segment);
}

// --- paths -----------------------------------------------------------------------------------

/** gitignore-style glob to a regex over absolute paths; a match also covers everything below it. */
function globRegex(glob: string): RegExp {
	// `dir/**` covers the directory itself too, so searching or listing it is caught.
	if (glob.endsWith("/**")) glob = glob.slice(0, -3);
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			out += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}(?:/.*)?$`, "s");
}

// Resolve a Read/Edit rule path the way Claude Code reads it: `//abs`, `~/home`, `/root-relative`,
// `./` and `../` relative to the project root, `**/...` anywhere. A bare name (`.env`) matches at
// any depth, like gitignore — stricter for deny rules, which is the side that matters here.
function rulePathRegex(spec: string, cwd: string, home: string): RegExp {
	const s = spec.trim();
	if (s.startsWith("//")) return globRegex(s.slice(1));
	if (s.startsWith("~/")) return globRegex(join(home, s.slice(2)));
	if (s.startsWith("**/")) return globRegex(`/${s}`);
	if (s.startsWith("/")) return globRegex(join(cwd, s));
	const parts = s.split("/");
	if (parts.length === 1) return globRegex(`/**/${s}`);
	let dir = cwd;
	while (parts[0] === "." || parts[0] === "..") {
		if (parts.shift() === "..") dir = dirname(dir);
	}
	return globRegex(join(dir, ...parts));
}

function pathMatches(rule: Rule, tools: string[], path: string, cwd: string, home: string): boolean {
	if (!tools.includes(rule.tool)) return false;
	if (rule.spec === undefined || rule.spec === "" || rule.spec === "*") return true;
	return rulePathRegex(rule.spec, cwd, home).test(path);
}

/** Whether a Read deny rule covers `path` (absolute). */
export function readDenied(policy: OrgPolicy, path: string, cwd: string, home: string): string | undefined {
	return policy.deny.map(parseRule).find((r) => r && pathMatches(r, ["Read"], path, cwd, home))?.raw;
}

/**
 * Drop grep/find/ls output lines naming a file the org denies reading. A search rooted above a
 * denied file (`grep -r password .` finding .env) would otherwise print its contents; Claude Code
 * applies Read rules to its own search tools the same way. Paths in Pi's output are relative to
 * the search root: `file:12: text` / `file-12- text` for grep, one path per line for find and ls.
 */
export function redactSearchOutput(
	policy: OrgPolicy,
	tool: string,
	input: Record<string, unknown> | undefined,
	text: string,
	cwd: string,
	home: string,
): { text: string; hidden: number } {
	if (!["grep", "find", "ls"].includes(tool)) return { text, hidden: 0 };
	const root = targetPath(tool, input, cwd, home);
	let hidden = 0;
	const kept = text.split("\n").filter((line) => {
		const rel = tool === "grep" ? /^(.*?)[:-]\d+[:-] /.exec(line)?.[1] ?? /^(.*?):\d+: \(unable/.exec(line)?.[1] : line.replace(/\/$/, "");
		if (!rel || rel.startsWith("[") || /limit reached|No files found|No matches/.test(line)) return true;
		const abs = isAbsolute(rel) ? rel : resolve(root, rel);
		const denied = readDenied(policy, abs, cwd, home);
		if (denied) hidden++;
		return !denied;
	});
	return { text: kept.join("\n"), hidden };
}

// --- decisions ---------------------------------------------------------------------------------

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const EDITS = new Set(["edit", "write"]);
/** Tools without a Claude Code counterpart that need no approval: memory, delegation (children check their own calls), meta tools. */
const UNGATED = /^(memory_\w+|subagent|advisor|usage_status|codemode|tool_search)$/;

export function targetPath(tool: string, input: Record<string, unknown> | undefined, cwd: string, home: string): string {
	const raw = typeof input?.path === "string" && input.path ? input.path : typeof input?.file_path === "string" ? input.file_path : ".";
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** The approval scope offered for a bash command: its first word, or two for git/gh/npm-style tools. */
export function bashScope(command: string): string {
	const words = (commandSegments(command)[0] ?? command).split(/\s+/).filter(Boolean);
	return words.length > 1 && !words[1].startsWith("-") ? `${words[0]} ${words[1]}` : (words[0] ?? "");
}

export function decide(
	policy: OrgPolicy,
	tool: string,
	input: Record<string, unknown> | undefined,
	ctx: { cwd: string; home: string; approvals: Approvals },
): Decision {
	const rules = (list: string[]) => list.map(parseRule).filter((r): r is Rule => !!r);
	const deny = rules(policy.deny), ask = rules(policy.ask), allow = rules(policy.allow);
	const label = policy.label ?? "your organisation's Claude policy";
	const open = policy.unlisted === "allow";

	if (UNGATED.test(tool)) return { verdict: "allow", reason: "no Claude Code counterpart" };

	if (tool === "bash") {
		const command = typeof input?.command === "string" ? input.command : "";
		const segments = commandSegments(command);
		for (const s of segments) {
			const r = deny.find((d) => bashMatches(d, s));
			if (r) return { verdict: "deny", rule: r.raw, reason: `\`${s}\` is denied by ${label} (${r.raw})` };
		}
		const approved = (s: string) => ctx.approvals.bash.some((p) => s === p || s.startsWith(`${p} `)) || ctx.approvals.tools.includes("bash");
		for (const s of segments) {
			const r = ask.find((a) => bashMatches(a, s));
			// Work mirrors Claude Code, where an ask rule asks every time; under the Personal policy
			// "allow for this session" covers asked commands too, or it would never stop asking.
			if (r && !(open && approved(s))) return { verdict: "ask", rule: r.raw, reason: `\`${s}\` needs approval under ${label} (${r.raw})` };
		}
		const covered = (s: string) => allow.some((a) => bashMatches(a, s)) || approved(s);
		if (open) return { verdict: "allow", reason: `no rule in ${label} covers it` };
		const uncovered = segments.filter((s) => !covered(s));
		return uncovered.length === 0 && segments.length > 0
			? { verdict: "allow", reason: "allowed by policy or approved for this session" }
			: { verdict: "ask", reason: `\`${uncovered[0] ?? command}\` is not on your organisation's allow list` };
	}

	if (READ_ONLY.has(tool) || EDITS.has(tool)) {
		const path = targetPath(tool, input, ctx.cwd, ctx.home);
		const claudeTools = EDITS.has(tool) ? ["Edit", "Write", "MultiEdit"] : ["Read"];
		const r = deny.find((d) => pathMatches(d, claudeTools, path, ctx.cwd, ctx.home));
		if (r) return { verdict: "deny", rule: r.raw, reason: `${path} is denied by ${label} (${r.raw})` };
		const a = ask.find((d) => pathMatches(d, claudeTools, path, ctx.cwd, ctx.home));
		if (a && !(open && ctx.approvals.tools.includes(tool))) return { verdict: "ask", rule: a.raw, reason: `${path} needs approval under ${label} (${a.raw})` };
		if (READ_ONLY.has(tool) || open) return { verdict: "allow", reason: READ_ONLY.has(tool) ? "read-only tools need no approval" : `no rule in ${label} covers it` };
		if (allow.some((d) => pathMatches(d, claudeTools, path, ctx.cwd, ctx.home)) || ctx.approvals.tools.includes(tool))
			return { verdict: "allow", reason: "allowed by policy or approved for this session" };
		return { verdict: "ask", reason: `editing ${path} needs approval (your organisation's Claude policy has bypass mode off)` };
	}

	const named = deny.find((d) => d.spec === undefined && d.tool.toLowerCase() === tool.toLowerCase());
	if (named) return { verdict: "deny", rule: named.raw, reason: `${tool} is denied by ${label}` };
	if (ctx.approvals.tools.includes(tool) || open) return { verdict: "allow", reason: open ? `no rule in ${label} covers it` : "approved for this session" };
	return { verdict: "ask", reason: `${tool} has no Claude Code counterpart in your organisation's policy` };
}
