// Agents never change shared systems: no push, no GitHub writes, no cluster, node or dotfiles
// changes. The parent does those after Jan says yes (AGENTS.md). Loaded only into subagent
// sessions, through subagents.defaultExtensions, this blocks bash commands that would. A pattern
// check that catches mistakes, not a sandbox: a script can still do anything.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A command name, any options before the subcommand, then the subcommand.
const OPTS = String.raw`(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s;&|-]\S*)?)*`;
const cmd = (tool: string, verbs: string) =>
	new RegExp(String.raw`(?:^|[\s;&|(\x60/])${tool}${OPTS}\s+(?:${verbs})(?=$|[\s;&|)])`);

const RULES: [string, RegExp][] = [
	["git push", cmd("git", "push")],
	["a GitHub write", cmd("gh", String.raw`pr\s+(?:merge|close|reopen|comment|review|create|edit|ready|lock|unlock)|issue\s+(?:create|close|reopen|comment|edit|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|(?:secret|variable|label)\s+(?:set|create|edit|delete)`)],
	["a cluster change", cmd("kubectl", String.raw`apply|create|delete|patch|replace|scale|edit|label|annotate|cordon|uncordon|drain|taint|autoscale|expose|run|set|rollout\s+(?:restart|undo|pause|resume)`)],
	["a Flux change", cmd("flux", "reconcile|suspend|resume|create|delete|bootstrap|install|uninstall|push|tag")],
	["a node change", cmd("talosctl", String.raw`apply-config|apply|upgrade|upgrade-k8s|reboot|reset|shutdown|edit|patch|bootstrap|rotate-ca|wipe|etcd\s+(?:remove-member|leave|forfeit-leadership|defrag)`)],
	["a Helm change", cmd("helm", "install|upgrade|uninstall|rollback|delete")],
	["a dotfiles apply", cmd("chezmoi", "apply|update|destroy|purge")],
];

const GH_API = /(?:^|[\s;&|(\x60/])gh\s+api\b([^;&|\n]*)/g;

/** What the command would change, or undefined when it only reads. */
export function sharedChange(command: string): string | undefined {
	if (/--dry-run(?!=none)\b/.test(command)) return undefined;
	for (const [what, re] of RULES) if (re.test(command)) return what;
	for (const [, args] of command.matchAll(GH_API)) {
		if (/(?:-X|--method)[\s=]*(?:GET|HEAD)\b/i.test(args)) continue;
		if (/^\s*graphql\b/.test(args)) {
			if (/\bmutation\b/.test(args)) return "a GitHub write";
			continue;
		}
		if (/(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)\b/i.test(args) || /\s(?:-f|-F|--field|--raw-field|--input)[\s=]/.test(args)) return "a GitHub write";
	}
	return undefined;
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
