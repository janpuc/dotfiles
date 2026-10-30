/** Ask Jan on his phone before bash commands change shared systems. */
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

// Pi Pocket 0.19 renamed a tool result's `content` to `output`; the drop-ins share one API level.
export const pocketApi = 2;

// Structural subset of PocketHost: a drop-in does not need a machine-specific host.ts path.
type ApprovalAnswer = { allow: boolean; by: string };
type Host = {
    approvals: {
        request(
            asked: {
                id: string;
                conversationId: ConversationId;
                taskId: TaskId;
                callId: string;
                tool: string;
                subject: string;
                reason: string;
                createdAt: number;
            },
            context: Context,
        ): Promise<ApprovalAnswer>;
    };
};

// Ported from agent-guard.ts's sharedChange. A mistake detector, not a shell sandbox.
// pr-merge-request deliberately has no write rule: it only submits hostile input to the
// separate broker, which decides. Do not exempt a whole command containing it: chained
// gh pr merge/API writes must still ask (and GitHub's ruleset denies pocket merges).
const OPTS = String.raw`(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s;&|-]\S*)?)*`;
const cmd = (tool: string, verbs: string) =>
    new RegExp(String.raw`(?:^|[\s;&|(\x60/])${tool}${OPTS}\s+(?:${verbs})(?=$|[\s;&|)\x60])`);
const MERGE_GH_PR = cmd("gh", String.raw`pr\s+merge`);
/** A raw `git push`, however it is spelled; agent-push is the only way the agent publishes. */
const RAW_GIT_PUSH = /(?:^|[\s;&|(\x60/"'])g\\?i\\?t["']?(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s;&|-]\S*)?)*\s+["']?p\\?u\\?s\\?h/;
const RULES: [string, RegExp][] = [
    ["push git commits", cmd("git", "push")],
    // agent-push is not asked about (Jan, 2026-10-29): it publishes a non-main branch as a
    // verified commit, and GitHub rulesets keep every main branch out of the agent's reach.
    ["merge a GitHub PR", MERGE_GH_PR],
    [
        "write to GitHub",
        cmd(
            "gh",
            String.raw`pr\s+(?:merge|close|reopen|review|lock|unlock)|issue\s+(?:create|close|reopen|comment|edit|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|(?:secret|variable|label)\s+(?:set|create|edit|delete)`,
        ),
    ],
    // kubectl, flux, talosctl and helm are not asked about (Jan, 2026-10-30): pocket's cluster
    // account is the read-only `view` role (no patch, delete, create, exec or secrets) and it has
    // no talosconfig, so the cluster refuses those changes itself. The rules only ever raised
    // false alarms, such as a script that printed kubectl commands for the main agent.
    ["apply or remove dotfiles", cmd("chezmoi", "apply|update|destroy|purge")],
];
const GH_API = /(?:^|[\s;&|(\x60/])gh\s+api\b([^;&|\n]*)/g;
const HTTP = /(?:^|[\s;&|(\x60/])(curl|wget|http|https|httpie)\b([^;&|\n]*)/g;
const HA_TARGET =
    /hass\.janpuc\.com|home-assistant\.janpuc\.com|\$HA_URL\b|\$\{HA_URL\}|\/api\/services\//i;
/**
 * The Home Assistant service calls that need no phone prompt: lights and scenes, and the
 * reload services that apply a configuration change in place. Everything else - a script,
 * a switch, a restart, the Supervisor - still asks Jan.
 */
const HA_ALLOWED_SERVICES = new Set([
    "light.turn_on",
    "light.turn_off",
    "light.toggle",
    "scene.turn_on",
    "automation.reload",
    "script.reload",
    "scene.reload",
    "homeassistant.reload_core_config",
    "homeassistant.reload_all",
    "group.reload",
    "template.reload",
    "input_boolean.reload",
    "input_select.reload",
    "input_number.reload",
    "input_text.reload",
    "input_datetime.reload",
    "input_button.reload",
    "timer.reload",
    "zone.reload",
]);
/** A service URL on Jan's own Home Assistant: the host, then the domain and the service. */
const HA_SERVICE_URL =
    /^(?:https?:\/\/(?:hass|home-assistant)\.janpuc\.com|\$\{?HA_URL\}?)\/api\/services\/([^/?#\s]+)\/([^/?#\s]+)/;
/** Curl options that can carry a second URL or a second request of their own. */
const HA_AMBIGUOUS_OPTIONS = /^(?:--config|--next|--url|-[A-Za-z]*[K:].*)$/;
/** A dry-run flag is not a curl option: such a command is not a plain service call. */
const HA_DRY_RUN = /^--dry-run(?:=|$)/;

/** What the command would change, or undefined for reads. */
/** One plain line for Jan's card: what the call does, before the raw command he sees under it. */
export function explain(command: string, change: string): string {
    const flat = command.replace(/\\\r?\n/g, " ");
    const repo = flat.match(/(?:-R|--repo)[= ]+["']?([\w.-]+\/[\w.-]+)/)?.[1] ?? "the current repository";
    if (change === "merge a GitHub PR") {
        const pr = flat.match(/\bpr\s+merge\s+(?:-\S+\s+)*#?(\d+)/)?.[1];
        return `Merge pull request ${pr ? `#${pr}` : "(number not given)"} in ${repo}.`;
    }
    if (change === "write to GitHub") {
        const m = flat.match(/\bgh\s+(pr|issue|release|repo|workflow|run|secret|variable|label)\s+(\w+)\s*["']?([^\s"']*)/);
        if (m) return `GitHub: ${m[2]} ${m[1]} ${m[3] || ""} in ${repo}.`.replace(/\s+/g, " ");
        const api = flat.match(/\bgh\s+api\s+(?:-\S+\s+\S+\s+)*["']?([^\s"']+)/)?.[1];
        return `GitHub API write${api ? ` to ${api}` : ""}.`;
    }
    if (change === "call a Home Assistant service") {
        const svc = flat.match(/\/api\/services\/([\w]+)\/([\w]+)/);
        const entity = flat.match(/entity_id["']?\s*[:=]\s*["']?([\w.]+)/)?.[1];
        return svc ? `Home Assistant: run ${svc[1]}.${svc[2]}${entity ? ` on ${entity}` : ""}.` : "Home Assistant: call a service.";
    }
    if (change === "change Home Assistant") {
        const path = flat.match(/\/api\/[\w/.-]+/)?.[0];
        return `Home Assistant: change something through its API${path ? ` (${path})` : ""}.`;
    }
    if (change === "push git commits") return "Push git commits (raw git push).";
    if (change === "apply or remove dotfiles") return "Apply or remove dotfiles with chezmoi.";
    return `This command will ${change}.`;
}

export function sharedChange(command: string): string | undefined {
    // Only bare, simple invocations qualify: no shell syntax, quoted payloads,
    // comments or substitutions can lend a dry-run flag to another command.
    // Require the guarded executable itself, not an interpreter/wrapper's argument.
    const dryRun = /^[A-Za-z0-9_./=:@,+% \t-]+$/.test(command) &&
        /^[ \t]*(?:[A-Za-z0-9_./-]+\/)?(?:agent-push|git|gh|kubectl|flux|talosctl|helm|chezmoi)[ \t]/.test(command) &&
        !/(?:^|[ \t])--dry-run(?:=|[ \t]+)(?:none|false)(?=$|[ \t])/.test(command) &&
        /(?:^|[ \t])--dry-run(?:=(?:client|server|true))?(?=$|[ \t])/.test(command);
    const normalized = command.replace(/['"\\]/g, "");
    const change = sharedChangeForm(command, dryRun) ?? sharedChangeForm(normalized, dryRun);
    // A light, a scene or a reload needs no phone prompt: it changes the home in place,
    // the way Jan expects, and never restarts Home Assistant.
    if (change === "call a Home Assistant service" && haServiceAllowed(command)) return undefined;
    return change;
}

/**
 * The tokens of one shell command, or undefined when the command uses shell syntax:
 * chaining, substitution, redirection or an unclosed quote. Quoted text stays inside the
 * token it belongs to, so a payload with spaces is one argument and not two commands.
 */
function shellTokens(command: string): string[] | undefined {
    const tokens: string[] = [];
    let token = "";
    let quote = "";
    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        if (quote) {
            if (ch === quote) quote = "";
            else token += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "\\") {
            const next = command[i + 1];
            if (next === "\n" || next === "\r") {
                i++;
                continue;
            }
            i++;
            token += command[i] ?? "";
            continue;
        }
        if (";&|()<>`\n\r".includes(ch)) return undefined;
        if (ch === " " || ch === "\t") {
            if (token) tokens.push(token);
            token = "";
            continue;
        }
        token += ch;
    }
    if (quote) return undefined;
    if (token) tokens.push(token);
    return tokens;
}

/**
 * True when the command is one simple curl call to an allowed Home Assistant service: one
 * command with no chaining and no substitution, exactly one service URL, on Jan's own
 * Home Assistant, sent as a POST.
 */
export function haServiceAllowed(command: string): boolean {
    // A substitution hides a second command, inside quotes too.
    if (/\$\(|`/.test(command)) return false;
    const tokens = shellTokens(command);
    if (!tokens || tokens.length < 2) return false;
    if (!/^(?:[A-Za-z0-9_./-]+\/)?curl$/.test(tokens[0]!)) return false;
    if (tokens.some((token) => HA_AMBIGUOUS_OPTIONS.test(token) || HA_DRY_RUN.test(token)))
        return false;
    // Exactly one service URL in the whole command, not one token holding two of them.
    if ((command.match(/\/api\/services\//g) ?? []).length !== 1) return false;
    const url = tokens.find((token) => token.includes("/api/services/"));
    if (!url) return false;
    const service = HA_SERVICE_URL.exec(url);
    if (!service) return false;
    if (!HA_ALLOWED_SERVICES.has(`${service[1]}.${service[2]}`)) return false;
    return isPostRequest(tokens);
}

/** True when a curl command sends a POST: an explicit method, or a body without a GET. */
function isPostRequest(tokens: string[]): boolean {
    let method = "";
    let body = false;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]!;
        const request = token.match(/^(?:-X|--request|--method)(.*)$/);
        if (request) {
            const value = request[1]!.startsWith("=")
                ? request[1]!.slice(1)
                : request[1] || tokens[++i] || "";
            method = value.toUpperCase();
            continue;
        }
        if (/^(?:-[dF]|--(?:data[\w-]*|json|form(?:-string)?|post-data|post-file|body-data|body-file))/.test(token)) {
            body = true;
            continue;
        }
        if (token === "-G" || token === "--get") return false;
    }
    if (method) return method === "POST";
    return body;
}

function sharedChangeForm(command: string, dryRun: boolean): string | undefined {
    for (const [, tool, args] of command.replace(/\\\r?\n/g, " ").matchAll(HTTP)) {
        if (!HA_TARGET.test(args!)) continue;
        // A curl config file (-K/--config, short flags such as -sK included) or --next/-: can
        // add a method, a body or more URLs that this line does not show: treat it as a write.
        if (/\s(?:--config|--next)(?=$|[\s=])|\s-[A-Za-z]*[K:](?=$|\s|[^\s-])/.test(args!))
            return "call a Home Assistant service";
        const writeMethod =
            /(?:-X|--request|--method)[\s=]*["']?(?:POST|PUT|PATCH|DELETE)\b/i.test(args!) ||
            /^\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(args!);
        const readMethod =
            /(?:-X|--request|--method)[\s=]*["']?(?:GET|HEAD)\b/i.test(args!) ||
            /^\s+(?:GET|HEAD)\b/i.test(args!) ||
            /\s(?:-G|-I|--get|--head|--spider)\b/.test(args!);
        const body =
            /\s(?:-[dF]|--(?:data[\w-]*|json|form(?:-string)?|post-data|post-file|body-data|body-file)(?=$|[\s=]))/.test(
                args!,
            );
        // HTTPie infers POST for key=value / key:=json request items (headers use a single colon).
        const httpieBody = /^(?:http|https|httpie)$/.test(tool!) && /\s[\w.-]+(?::=|=)/.test(args!);
        if (writeMethod || (!readMethod && (body || httpieBody)))
            return /\/api\/services\//i.test(args!)
                ? "call a Home Assistant service"
                : "change Home Assistant";
    }
    // gh pr merge has no dry-run flag. Never let a stray --dry-run elsewhere in a
    // command exempt a merge (especially a malformed/chained lane command).
    if (MERGE_GH_PR.test(command)) return "merge a GitHub PR";
    if (dryRun) return undefined;
    for (const [what, re] of RULES) if (re.test(command)) return what;
    for (const [, args] of command.matchAll(GH_API)) {
        if (/(?:-X|--method)[\s=]*(?:GET|HEAD)\b/i.test(args!)) continue;
        if (/^\s*graphql\b/.test(args!)) {
            if (/\bmutation\b/.test(args!)) return "write to GitHub";
            continue;
        }
        if (
            /(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)\b/i.test(args!) ||
            /\s(?:-f|-F|--field|--raw-field|--input)[\s=]/.test(args!)
        )
            return "write to GitHub";
    }
    return undefined;
}

export default function createApprovals(host: Host) {
    return defineExtension({
        name: "approvals",
        sections: [
            section(
                "shared_system_approvals",
                () =>
                    "Bash commands that change shared systems ask Jan on his phone before they run. State plainly what the command will do before running it. Never try to get around a denial.",
            ),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if (call.name !== "bash") return undefined;
                    const command = String((call.arguments as { command?: unknown }).command ?? "");
                    const change = sharedChange(command);
                    if (!change) return undefined;
                    // A raw git push is never asked about (Jan, 2026-10-30): it would publish unverified
                    // commits that the rulesets refuse, and it only ever cost him a tap. Refuse it here and
                    // point at the tool that publishes verified commits without asking.
                    if (change === "push git commits" && RAW_GIT_PUSH.test(command))
                        return {
                            block:
                                "Raw `git push` is not used here and nobody was asked. Publish the branch with `agent-push` " +
                                "(run it in the repository on your branch; it creates one verified commit and does not ask Jan).",
                        };
                    const subject = command.trim().replace(/[\r\n]+/g, " ");
                    const reason = `${explain(command, change)} Allow only if you expected this.`;
                    // Keyed by call: a codemode script can make several calls in one task.
                    const key = `approvals.answer:${call.id}`;
                    let answer = await api.memo<ApprovalAnswer>(key, context);
                    if (answer === undefined) {
                        const asked = await host.approvals.request(
                            {
                                id: `${api.taskId}:${call.id}`,
                                conversationId: api.conversationId,
                                taskId: api.taskId,
                                callId: call.id,
                                tool: call.name,
                                subject,
                                reason,
                                createdAt: Date.now(),
                            },
                            context,
                        );
                        answer = await api.memo<ApprovalAnswer>(key, asked, context);
                    }
                    return answer.allow
                        ? undefined
                        : {
                              block: `${answer.by} denied this bash call: ${reason} Call: ${subject}`,
                          };
                },
            }),
        ],
    });
}
