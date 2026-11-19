// Agents never change shared systems: no push, no GitHub writes, no cluster, node or dotfiles
// changes or Home Assistant writes. Children block them through agent-guard-child.ts, while
// Jan's sessions ask through agent-guard-ask.ts. A pattern check that catches mistakes, not a
// sandbox: a script can still do anything.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function unwrap(words: string[]): string[] {
	words = [...words];
	while (words.length) {
		if (assignment(words[0])) { words.shift(); continue; }
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
				return body === undefined || /^\$(?:\w+|\{\w+\}|\(\))$/.test(body.trim())
					? "an unclassified shell command" : sharedChange(body, profile);
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

/** What the command would change, or undefined when it only reads. */
export function sharedChange(command: string, profile = process.env.PI_GUARD_PROFILE ?? "personal"): string | undefined {
	try {
		for (const words of simpleCommands(command.replace(/\\\r?\n/g, ""))) {
			const what = simpleChange(words, profile);
			if (what) return what;
		}
	} catch {
		return "an unclassified shell command";
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const what = sharedChange(String((event.input as { command?: unknown }).command ?? ""));
		if (!what) return;
		return {
			block: true,
			reason: `Blocked ${what}: agents don't change shared systems. Report the exact command to the parent, which runs it after Jan says yes.`,
		};
	});
}
