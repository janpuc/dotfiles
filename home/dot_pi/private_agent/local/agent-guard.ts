// The hard-deny list: the few commands that cannot be undone are refused without a question, in
// every session and every subagent child. Everything else runs. Safety comes from recoverability
// (git, Flux, volume backups, NAS snapshots, restic), not from prompts. Jan lifts one refusal for
// one command by telling the agent, which reruns it as AGENT_OVERRIDE="<reason>" <command>.
// Refusals, overrides and notable actions (pushes, merges, deploys) go to an append-only log
// that `agent digest` reads. A pattern check that catches mistakes, not a sandbox.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

// A command name, any options before the subcommand, then the subcommand.
const OPTS = String.raw`(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s;&|-]\S*)?)*`;
const cmd = (tool: string, verbs: string) =>
	new RegExp(String.raw`^(?:\S*/)?${tool}${OPTS}\s+(?:${verbs})(?=$|\s)`);

const RULES: [string, RegExp][] = [
	["git push", cmd("git", "push")],
	["a GitHub write", cmd("gh", String.raw`pr\s+(?:merge|close|reopen|comment|review|create|edit|ready|lock|unlock)|issue\s+(?:create|close|reopen|comment|edit|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|(?:secret|variable|label)\s+(?:set|create|edit|delete)`)],
	["a cluster change", cmd("kubectl", String.raw`apply|create|delete|patch|replace|scale|edit|label|annotate|cordon|uncordon|drain|taint|autoscale|expose|run|set|rollout\s+(?:restart|undo|pause|resume)`)],
	["a Flux change", cmd("flux", "reconcile|suspend|resume|create|delete|bootstrap|install|uninstall|push|tag")],
	["a node change", cmd("talosctl", String.raw`apply-config|apply|upgrade|upgrade-k8s|reboot|reset|shutdown|edit|patch|bootstrap|rotate-ca|wipe|etcd\s+(?:remove-member|leave|forfeit-leadership|defrag)`)],
	["a Helm change", cmd("helm", "install|upgrade|uninstall|rollback|delete")],
	["a dotfiles apply", cmd("chezmoi", "apply|update|destroy|purge")],
];

// This deliberately handles ordinary shell command forms, not arbitrary shell programs.
// Quotes keep payloads intact. Substitutions and subshells are checked as commands too.
function simpleCommands(source: string): string[][] {
	const commands: string[][] = [];
	let i = 0;
	const scan = (end = "") => {
		let words: string[] = [], word = "", started = false, quote = "";
		const flushWord = () => { if (started) words.push(word); word = ""; started = false; };
		const flush = () => { flushWord(); if (words.length) commands.push(words); words = []; };
		while (i < source.length) {
			const c = source[i++];
			if (!quote && end && c === end) { flush(); return; }
			if (c === "\\" && quote !== "'") {
				const next = source[i];
				if (next !== undefined && (!quote || /["\\$`]/.test(next))) { word += next; i++; }
				else word += c;
				started = true;
			} else if (quote === "'") {
				if (c === "'") quote = ""; else word += c;
			} else if ((c === "$" && source[i] === "(") || c === "`") {
				if (c === "$") i++;
				scan(c === "$" ? ")" : "`");
				word += "$()";
				started = true;
			} else if (quote) {
				if (c === quote) quote = ""; else word += c;
			} else if (c === "'" || c === '"') {
				quote = c; started = true;
			} else if (c === "(") {
				flush(); scan(")");
			} else if (/[;|&\n)]/.test(c)) flush();
			else if (/\s/.test(c)) flushWord();
			else if (c === "#" && !started) {
				while (i < source.length && source[i] !== "\n") i++;
			} else { word += c; started = true; }
		}
		if (quote || end) throw new Error("Unclosed shell quote or substitution");
		flush();
	};
	scan();
	return commands;
}

const basename = (word: string) => word.split("/").at(-1) ?? "";
const assignment = (word: string) => /^[A-Za-z_][\w]*=/.test(word);

function unwrap(words: string[], assignments: string[] = []): string[] {
	words = [...words];
	while (words.length) {
		if (assignment(words[0])) { assignments.push(words.shift()!); continue; }
		const tool = basename(words[0]);
		if (!["env", "sudo", "command", "exec", "nohup", "time"].includes(tool)) break;
		words.shift();
		while (words[0]?.startsWith("-")) {
			const flag = words.shift()!;
			if (flag === "--") break;
			if ((tool === "sudo" && /^(?:-[ugphCrT]|--user|--group|--host|--prompt|--chdir|--chroot|--command-timeout)$/.test(flag))
				|| (tool === "env" && /^(?:-u|-C|--unset|--chdir)$/.test(flag))
				|| (tool === "exec" && flag === "-a")
				|| (tool === "time" && /^(?:-[fo]|--format|--output)$/.test(flag))) words.shift();
		}
	}
	return words;
}

// Last explicit method wins. Support separate, =value and curl's compact -sSXPOST form.
function methodOption(args: string[], long: string, short?: string): string | undefined {
	let method: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === long || word === short) method = args[++i];
		else if (word.startsWith(`${long}=`)) method = word.slice(long.length + 1);
		else if (short && new RegExp(`^-[sSfFLkv]*${short.slice(1)}`).test(word)) {
			method = word.slice(word.indexOf(short.slice(1)) + 1).replace(/^=/, "") || args[++i];
		}
	}
	return method?.toUpperCase();
}

function homeAssistantWrite(tool: string, args: string[]): boolean {
	if (!["curl", "wget", "http", "https"].includes(tool)) return false;
	const targets = args.map((word) => word.replace(/^--url=/, ""))
		.filter((word) => /^(?:https?:\/\/hass\.janpuc\.com(?::\d+)?|\$HA_URL|\$\{HA_URL\})\/api\//i.test(word));
	if (!targets.some((url) => !/\/api\/template\/?(?:[?#].*)?$/.test(url))) return false;
	let method: string;
	if (tool === "curl") {
		const data = args.some((word) => /^-[sSfFLkv]*[dT]/.test(word)
			|| /^(?:--data(?:-[\w-]+)?|--json|--upload-file)(?:=|$)/.test(word));
		method = methodOption(args, "--request", "-X")
			?? (args.some((word) => word === "--get" || /^-[sSfFLkv]*G/.test(word)) ? "GET"
				: args.includes("-I") || args.includes("--head") ? "HEAD" : data ? "POST" : "GET");
	} else if (tool === "wget") {
		method = methodOption(args, "--method")
			?? (args.some((word) => /^(?:--post-data|--post-file|--body-data|--body-file)(?:=|$)/.test(word)) ? "POST" : "GET");
	} else {
		method = args.find((word) => /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(word))?.toUpperCase()
			?? (args.some((word) => /^[\w.-]+(?::?=(?!=)|@)/.test(word)) ? "POST" : "GET");
	}
	return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function dryRun(tool: string, args: string[], what: string): boolean {
	const valueFlag = tool === "git" ? /^(?:-C|-c|-o|--push-option|--repo|--receive-pack|--exec|--git-dir|--work-tree)$/
		: tool === "chezmoi" ? /^(?:-S|-D|-c|--source|--destination|--config)$/
			: /^(?:-f|-n|--filename|--namespace|--values|--set|--set-string|--context|--kubeconfig)$/;
	const options: string[] = [];
	for (let i = 0; i < args.length && args[i] !== "--"; i++) {
		if (valueFlag.test(args[i])) i++;
		else options.push(args[i]);
	}
	args = options;
	if (["kubectl", "helm", "flux", "talosctl"].includes(tool)) {
		let value: string | undefined;
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--dry-run") value = args[i + 1] === "none" ? "none" : "true";
			else if (args[i].startsWith("--dry-run=")) value = args[i].slice(10);
		}
		return value !== undefined && value !== "none";
	}
	return (what === "git push" || tool === "chezmoi" && cmd("chezmoi", "apply").test([tool, ...args].join(" ")))
		&& args.some((word) => word === "--dry-run" || word === "-n");
}

function workChange(tool: string, args: string[]): string | undefined {
	// Global CLI options can precede the service or verb. Skip only known value options.
	const valueFlags = new Set([
		"--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--color",
		"--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format", "--exclude", "--include",
		"--acl", "--grants", "--storage-class", "--sse", "--sse-c", "--sse-c-key", "--sse-kms-key-id",
		"--sse-c-copy-source", "--sse-c-copy-source-key", "--metadata", "--metadata-directive", "--copy-props",
		"--website-redirect", "--content-type", "--cache-control", "--content-disposition", "--content-encoding",
		"--content-language", "--expires", "--source-region", "--page-size", "--expected-size",
		"--checksum-mode", "--checksum-algorithm", "--request-payer", "--cli-input-json", "--cli-input-yaml",
	]);
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (valueFlags.has(args[i])) i++;
		else if (!args[i].startsWith("-")) positional.push(args[i]);
	}
	const [service, verb] = positional;
	if (tool === "aws") {
		const readOnly = service === "help" || verb === "help"
			|| service === "s3" && verb === "ls"
			|| service === "sts" && verb === "get-caller-identity"
			|| service !== "s3" && /^(?:(?:describe|list|get|head|lookup|search|batch-get|validate)-|(?:scan|query|wait)$)/.test(verb ?? "");
		if (!readOnly) return "an AWS write";
	}
	if (["terraform", "tofu"].includes(tool) && (/^(?:apply|destroy|import|taint)$/.test(service ?? "")
		|| service === "state" && ["rm", "mv"].includes(verb))) return "a terraform change";
	if ((tool === "assume" || tool === "granted" && service === "assume") && args.some((arg) => /prod/i.test(arg))) return "assuming a production profile";
}

function simpleChange(input: string[], profile: string): string | undefined {
	const words = unwrap(input);
	if (!words.length) return;
	const tool = basename(words[0]), args = words.slice(1);
	if (["bash", "sh", "zsh", "dash", "fish"].includes(tool)) {
		for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
			if (/^-[^-]*c/.test(args[i])) {
				const body = args[i + 1];
				return body === undefined ? undefined : sharedChange(body, profile);
			}
		}
	}
	if (tool === "eval") return sharedChange(args.join(" "), profile);
	if (profile === "work") {
		const what = workChange(tool, args);
		if (what) return what;
	}
	if (homeAssistantWrite(tool, args)) return "a Home Assistant write";
	const command = words.join(" ");
	for (const [what, re] of RULES) if (re.test(command)) return dryRun(tool, args, what) ? undefined : what;
	const api = tool === "gh" && command.match(cmd("gh", "api"));
	if (api) {
		const apiArgs = args.slice(args.indexOf("api") + 1);
		const method = methodOption(apiArgs, "--method", "-X");
		if (apiArgs.includes("graphql")) {
			const query = apiArgs.filter((word) => /^(?:-[fF]|--(?:raw-)?field=)?query=/.test(word)).join(" ");
			return /\bmutation\b/.test(query) ? "a GitHub write" : undefined;
		}
		if (method === "GET" || method === "HEAD") return;
		if (method && /^(?:POST|PUT|PATCH|DELETE)$/.test(method)
			|| apiArgs.some((word) => /^(?:-[fF].*|--(?:field|raw-field|input)(?:=.*)?)$/.test(word))) return "a GitHub write";
	}
}

/** The notable action a command takes (push, merge, deploy), for the action log. */
export function sharedChange(command: string, profile = process.env.PI_GUARD_PROFILE ?? "personal"): string | undefined {
	try {
		for (const words of simpleCommands(command.replace(/\\\r?\n/g, ""))) {
			const what = simpleChange(words, profile);
			if (what) return what;
		}
	} catch {
		return undefined;
	}
}

const DEFAULT_BRANCH = /^(?:refs\/heads\/)?(?:main|master)$/;
// Tools that only show text, so a pattern in their arguments is a search, not an action.
const TEXT_TOOLS = new Set(["grep", "rg", "ag", "cat", "less", "more", "head", "tail", "echo", "printf", "bat", "jq", "yq", "wc", "diff", "sed", "awk", "find", "ls", "file"]);
const PROD = /(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)/i;

function forcePush(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[i]) ? 2 : 1;
	if (args[i] !== "push") return;
	const rest = args.slice(i + 1);
	const flags = rest.filter((word) => word.startsWith("-"));
	const positional = rest.filter((word, n) => !word.startsWith("-") && !/^(?:-o|--push-option|--repo|--receive-pack|--exec)$/.test(rest[n - 1] ?? ""));
	const refspecs = positional.slice(1);
	if (flags.some((flag) => flag === "--mirror")) return "a mirror push";
	const deleting = flags.some((flag) => flag === "--delete" || /^-[^-]*d/.test(flag));
	if (deleting && refspecs.some((ref) => DEFAULT_BRANCH.test(ref))) return "deleting a default branch";
	if (refspecs.some((ref) => ref.startsWith(":") && DEFAULT_BRANCH.test(ref.slice(1)))) return "deleting a default branch";
	const force = flags.some((flag) => /^--force(?:-with-lease)?(?:=.*)?$/.test(flag) || /^-[^-]*f/.test(flag));
	const forced = refspecs.filter((ref) => force || ref.startsWith("+"));
	if (!forced.length && !force) return;
	if (force && (!refspecs.length || flags.includes("--all") || flags.includes("--branches")))
		return "a force push without a named branch (name it: git push -f origin <branch>)";
	for (const ref of forced) {
		const target = ref.replace(/^\+/, "").split(":").at(-1)!;
		if (target === "HEAD" || target.includes("*") || DEFAULT_BRANCH.test(target)) return "a force push to a default branch";
	}
}

function kubectlDelete(args: string[]): string | undefined {
	const positional = args.filter((word, n) => !word.startsWith("-") && !/^(?:-n|--namespace|--context|--kubeconfig|-l|--selector|-o|--output)$/.test(args[n - 1] ?? ""));
	if (positional[0] !== "delete") return;
	const kinds = (positional[1] ?? "").split(",").map((kind) => kind.split("/")[0].toLowerCase());
	if (kinds.some((kind) => /^(?:ns|namespaces?)$/.test(kind))) return "deleting a Kubernetes namespace";
	if (kinds.some((kind) => /^(?:pvc?|persistentvolumes?|persistentvolumeclaims?)$/.test(kind))) return "deleting a persistent volume or claim";
}

function terraform(args: string[], profile: string, text: string, cwd: string): string | undefined {
	const positional = args.filter((word) => !word.startsWith("-"));
	const verb = positional[0] === "run-all" || positional[0] === "run" ? positional[1] : positional[0];
	if (verb === "destroy" || verb === "apply" && args.some((word) => /^--?destroy$/.test(word))) return "a terraform destroy";
	if (verb === "apply" && profile === "work" && (PROD.test(text) || PROD.test(cwd))) return "a terraform apply on production";
}

const TEXT_RULES: [string, RegExp][] = [
	["deleting a NAS dataset or snapshot", /\b(?:zfs|zpool)\s+destroy\b|\b(?:pool\.dataset\.delete|pool\.snapshot\.delete|zfs\.snapshot\.delete|pool\.dataset\.destroy_snapshots)\b/],
	["deleting a NAS dataset or snapshot", /^(?=.*\bDELETE\b).*\/api\/v2\.0\/(?:pool\/dataset|pool\/snapshot|zfs\/snapshot)\//is],
	["sending a message in Jan's name", /\/_matrix\/client\/\S*\/send\/|slack\.com\/api\/chat\.(?:postMessage|scheduleMessage|update)|hooks\.slack\.com\/|api\.(?:x|twitter)\.com\/[\d.]+\/(?:tweets|statuses\/update)|discord(?:app)?\.com\/api\/(?:v\d+\/)?(?:webhooks|channels\/\d+\/messages)|gmail\.googleapis\.com\/\S*\/send|graph\.microsoft\.com\/\S*\/sendMail|\/api\/v1\/statuses\b|com\.atproto\.repo\.createRecord|\bsmtps?:\/\/|tell application "(?:Messages|Mail)"/i],
];

function denied(words: string[], profile: string, cwd: string, env = ""): string | undefined {
	if (!words.length) return;
	const tool = basename(words[0]), args = words.slice(1), text = words.join(" ");
	if (tool === "git") return forcePush(args);
	if (tool === "gh" && cmd("gh", String.raw`repo\s+delete`).test(text)) return "deleting a GitHub repository";
	if (tool === "kubectl" && !dryRun(tool, args, "")) return kubectlDelete(args);
	if (tool === "talosctl" && cmd("talosctl", "reset|wipe|upgrade-k8s").test(text) && !dryRun(tool, args, "")) return "a talosctl reset, wipe or Kubernetes upgrade";
	if (["terraform", "tofu", "terragrunt"].includes(tool)) return terraform(args, profile, `${env} ${text}`, cwd);
	if (["sendmail", "msmtp", "swaks", "signal-cli", "matrix-commander", "toot", "twurl"].includes(tool)
		|| ["mail", "mailx", "mutt", "neomutt"].includes(tool) && args.some((word) => word.includes("@"))) return "sending a message in Jan's name";
	if (TEXT_TOOLS.has(tool)) return;
	for (const [what, re] of TEXT_RULES) if (re.test(text)) return what;
}

export interface Verdict { denied?: string; overrides: { what: string; reason: string }[] }

/** The first hard-denied part of a command, and the refusals it lifted with AGENT_OVERRIDE. */
export function hardDeny(command: string, profile = process.env.PI_GUARD_PROFILE ?? "personal", cwd = process.cwd(), canOverride = true): Verdict {
	const verdict: Verdict = { overrides: [] };
	const check = (source: string, override: string | undefined) => {
		let commands: string[][];
		try {
			commands = simpleCommands(source.replace(/\\\r?\n/g, ""));
		} catch {
			// Unbalanced quoting: judge the raw text line by line rather than refuse everything.
			commands = source.split("\n").map((line) => line.trim().split(/\s+/).filter(Boolean));
		}
		for (const raw of commands) {
			const assignments: string[] = [];
			const words = unwrap(raw, assignments);
			const own = assignments.find((word) => word.startsWith("AGENT_OVERRIDE="))?.slice(15).trim();
			const reason = own || override;
			const tool = basename(words[0] ?? ""), args = words.slice(1);
			if (["bash", "sh", "zsh", "dash", "fish"].includes(tool)) {
				const c = args.findIndex((word) => /^-[^-]*c$/.test(word));
				if (c >= 0 && args[c + 1] !== undefined) { check(args[c + 1], reason); if (verdict.denied) return; continue; }
			}
			if (tool === "eval") { check(args.join(" "), reason); if (verdict.denied) return; continue; }
			const what = denied(words, profile, cwd, assignments.join(" "));
			if (!what) continue;
			if (reason && canOverride) verdict.overrides.push({ what, reason });
			else { verdict.denied = what; return; }
		}
	};
	check(command, undefined);
	return verdict;
}

export function actionLog(): string {
	return process.env.AGENT_ACTION_LOG || join(homedir(), ".local/state/agents/actions.jsonl");
}

/** Append one record to the action log. A log failure never blocks the command. */
export function logAction(kind: "denied" | "override" | "action", what: string, command: string, extra: Record<string, unknown> = {}) {
	try {
		const file = actionLog();
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({
			ts: new Date().toISOString(), host: hostname().split(".")[0], project: process.env.PI_PROJECT ?? null,
			task: process.env.PI_TASK ?? null, child: isChild() || undefined, kind, what, command: command.slice(0, 300), ...extra,
		}) + "\n", { mode: 0o600 });
	} catch { /* the log is a record, not a gate */ }
}

const isChild = () => process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const child = isChild();
		const verdict = hardDeny(command, undefined, ctx.cwd, !child);
		if (verdict.denied) {
			logAction("denied", verdict.denied, command);
			return {
				block: true,
				reason: child
					? `Refused ${verdict.denied}: it cannot be undone. Report the exact command to your parent.`
					: `Refused ${verdict.denied}: it cannot be undone. Only Jan can lift this, for one command. If he has told you to, rerun it as AGENT_OVERRIDE="<his reason>" <command>, otherwise ask him in one line.`,
			};
		}
		for (const { what, reason } of verdict.overrides) logAction("override", what, command, { reason });
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const what = sharedChange(command);
		if (what) logAction("action", what, command, { ok: !event.isError });
	});
}
