/** Allow listed shared-system writes and block destructive ones without asking anybody. */
import { execFile } from "node:child_process";
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";

// Pi Pocket 0.19 renamed a tool result's `content` to `output`; the drop-ins share one API level.
export const pocketApi = 2;

type Unlock = "ha-restart" | "ha-update";
type Grant = { expiresAt: number; remaining: number };
// Shared with ask-jan.ts across Pocket's separate imports and hot reloads, not restarts.
const GRANTS = Symbol.for("jan.pi-pocket.home-assistant-grants.v1");
const grants = ((globalThis as typeof globalThis & { [GRANTS]?: Map<string, Grant> })[GRANTS] ??= new Map());

// Ported from agent-guard.ts's sharedChange. A mistake detector, not a shell sandbox.
// pr-merge-request deliberately has no write rule: it only submits hostile input to the
// separate broker, which decides. Do not exempt a whole command containing it: chained
// gh pr merge/API writes are still blocked, and GitHub's ruleset denies pocket merges.
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
            String.raw`pr\s+(?:merge|close|reopen|edit|lock|unlock)|issue\s+(?:close|reopen|edit|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|workflow\s+(?:run|enable|disable)|run\s+(?:cancel|delete)|(?:secret|variable|label)\s+(?:set|create|edit|delete)`,
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
 * The Home Assistant service calls that are allowed: lights and scenes, and the reload
 * services that apply a configuration change in place. Everything else is blocked, including
 * a script, a switch, a restart and the Supervisor.
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
/** The template API on Jan's own Home Assistant, exactly. */
const HA_TEMPLATE_URL = /^(?:https:\/\/(?:hass|home-assistant)\.janpuc\.com|\$\{?HA_URL\}?)\/api\/template$/;
/** Curl options that can carry a second URL or a second request of their own. */
const HA_AMBIGUOUS_OPTIONS = /^(?:--config|--next|--url|-[A-Za-z]*[K:].*)$/;
/** A dry-run flag is not a curl option: such a command is not a plain service call. */
const HA_DRY_RUN = /^--dry-run(?:=|$)/;

/** What the command would change, or undefined for reads. */
/** A hand-built GitHub commit or ref write: agent-push is the only way the agent publishes. */
const HAND_BUILT_COMMIT =
    /createCommitOnBranch|createRef|updateRef|repos\/[^\s"']+\/(?:contents|git\/(?:refs|commits|trees|blobs))\b/i;

/** `gh pr close|reopen|edit N -R owner/repo` as one simple invocation, or undefined. */
function ownPrCandidate(command: string): { pr: string; repo: string } | undefined {
    if (/[;&|`\n]|\$\(/.test(command)) return undefined;
    const tokens = shellTokens(command);
    if (!tokens || !/^(?:[\w/.-]*\/)?gh$/.test(tokens[0] ?? "") || tokens[1] !== "pr" ||
        !["close", "reopen", "edit"].includes(tokens[2] ?? "")) return undefined;
    const pr = tokens[3]?.match(/^#?(\d+)$/)?.[1];
    if (!pr) return undefined;
    const takesValue = new Set([
        "--title", "-t", "--body", "-b", "--body-file", "-F", "--comment", "-c",
        "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer",
        "--add-assignee", "--remove-assignee", "--milestone", "--base", "-B",
        "--add-project", "--remove-project",
    ]);
    const repos: string[] = [];
    for (let i = 4; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === "--") return undefined;
        if (takesValue.has(token)) {
            if (tokens[++i] === undefined) return undefined;
            continue;
        }
        if (token === "-R" || token === "--repo") {
            const value = tokens[++i];
            if (value === undefined) return undefined;
            repos.push(value);
        } else if (/^(?:-R|--repo)=/.test(token)) repos.push(token.slice(token.indexOf("=") + 1));
        else if (token.startsWith("-R")) return undefined;
    }
    return repos.length === 1 && /^janpuc\/[\w.-]+$/.test(repos[0]!) ? { pr, repo: repos[0]! } : undefined;
}

/** True only when GitHub says the PR was opened by the agent's own App. Fails closed. */
function prAuthorIsAgent(pr: string, repo: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile("gh", ["pr", "view", pr, "-R", repo, "--json", "author", "--jq", ".author.login"],
            { timeout: 15000 }, (error, stdout) => resolve(!error && stdout.trim() === "app/janpuc-agent"));
    });
}

/** One plain line for a refusal: what the call does, before the raw command. */
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

const GH_PR_REVIEW = cmd("gh", String.raw`pr\s+review`);
const GH_COMMENT = cmd("gh", String.raw`(?:pr|issue)\s+comment`);

/** Option names for review and comment commands, excluding their argument values. */
function ghCommentOptions(tokens: string[]): string[] | undefined {
    const takesValue = new Set(["--body", "-b", "--body-file", "-F", "--repo", "-R", "--hostname"]);
    const options: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === "--") break;
        if (token.startsWith("--")) {
            const name = token.split("=", 1)[0]!;
            options.push(name);
            if (takesValue.has(name) && !token.includes("=") && tokens[++i] === undefined) return undefined;
        } else if (/^-[A-Za-z]/.test(token)) {
            for (let j = 1; j < token.length && token[j] !== "="; j++) {
                const name = `-${token[j]}`;
                options.push(name);
                if (takesValue.has(name)) {
                    if (j === token.length - 1 && tokens[++i] === undefined) return undefined;
                    break;
                }
            }
        }
    }
    return options;
}

/** A comment-only review is a PR comment. Approvals and change requests stay blocked. */
function ghPrReviewCommentAllowed(command: string): boolean {
    const tokens = shellTokens(command);
    if (!tokens || !/^(?:[A-Za-z0-9_./-]+\/)?gh$/.test(tokens[0] ?? "")) return false;
    const review = tokens.findIndex((token, index) => token === "review" && tokens[index - 1] === "pr");
    if (review === -1) return false;
    const options = ghCommentOptions(tokens.slice(review + 1));
    if (!options || options.some((option) => ["--approve", "--request-changes", "-a", "-r"].includes(option)))
        return false;
    return options.includes("--comment") || options.includes("-c");
}

/** Adding a comment is allowed. Changing or deleting the last comment is not. */
function ghCommentAllowed(command: string): boolean {
    const tokens = shellTokens(command);
    if (!tokens) {
        // Compound comments stay allowed, with a conservative check when payloads cannot be parsed.
        const normalized = command.replace(/['"\\]/g, "");
        const invocation = GH_COMMENT.exec(normalized);
        return Boolean(invocation && !/--(?:delete-last|edit-last)(?=$|[\s=;&|)])/.test(
            normalized.slice(invocation.index + invocation[0].length)));
    }
    if (!/^(?:[A-Za-z0-9_./-]+\/)?gh$/.test(tokens[0] ?? "")) return false;
    const comment = tokens.findIndex((token, index) => token === "comment" && ["pr", "issue"].includes(tokens[index - 1] ?? ""));
    if (comment === -1) return false;
    const options = ghCommentOptions(tokens.slice(comment + 1));
    return Boolean(options && !options.some((option) => ["--delete-last", "--edit-last"].includes(option)));
}

/** True only for the two API write forms an agent may use: open a PR or comment on one. */
function ghApiWriteAllowed(args: string): boolean {
    const tokens = shellTokens(args);
    if (!tokens) return false;
    const takesValue = new Set([
        "-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field",
        "--input", "--hostname", "--jq", "--template", "--cache",
    ]);
    let endpoint = "", method = "", body = false;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (takesValue.has(token)) {
            const value = tokens[++i];
            if (value === undefined) return false;
            if (token === "-X" || token === "--method") method = value.toUpperCase();
            if (["-f", "-F", "--field", "--raw-field", "--input"].includes(token)) body = true;
            continue;
        }
        const attachedMethod = token.match(/^(?:-X|--method=)(.+)$/i);
        if (attachedMethod) { method = attachedMethod[1]!.toUpperCase(); continue; }
        if (/^(?:-[fF].+|--(?:field|raw-field|input)=)/.test(token)) { body = true; continue; }
        if (token.startsWith("-")) continue;
        if (endpoint) return false;
        endpoint = token;
    }
    if (method !== "POST" && (method || !body)) return false;
    return /^repos\/[\w.-]+\/[\w.-]+\/pulls$/.test(endpoint) ||
        /^repos\/[\w.-]+\/[\w.-]+\/(?:issues|pulls)\/\d+\/comments$/.test(endpoint);
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
    const change = sharedChangeForm(command, dryRun) ?? sharedChangeForm(normalized, dryRun, command);
    // A light, a scene or a reload changes the home in place without restarting Home Assistant.
    if (change === "call a Home Assistant service" && haServiceAllowed(command)) return undefined;
    // Rendering a template only reads states, the same as GET /api/states.
    if (change === "change Home Assistant" && haTemplateRead(command)) return undefined;
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
    let started = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        if (quote) {
            if (ch === quote) quote = "";
            else token += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            started = true;
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
            started = true;
            token += command[i] ?? "";
            continue;
        }
        if (";&|()<>`\n\r".includes(ch)) return undefined;
        if (ch === " " || ch === "\t") {
            if (started) tokens.push(token);
            token = "";
            started = false;
            continue;
        }
        started = true;
        token += ch;
    }
    if (quote) return undefined;
    if (started) tokens.push(token);
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

/**
 * True when the command is one simple curl POST to Jan's own Home Assistant /api/template, and
 * to no other URL: the template API renders a template and changes nothing.
 */
export function haTemplateRead(command: string): boolean {
    if (/\$\(|`/.test(command)) return false;
    const tokens = shellTokens(command);
    if (!tokens || tokens.length < 2) return false;
    if (!/^(?:[A-Za-z0-9_./-]+\/)?curl$/.test(tokens[0]!)) return false;
    if (tokens.some((token) => HA_AMBIGUOUS_OPTIONS.test(token) || HA_DRY_RUN.test(token)))
        return false;
    const urls = tokens.filter((token) => /^(?:[a-z]+:\/\/|\$\{?HA_URL\b)/i.test(token));
    return urls.length === 1 && HA_TEMPLATE_URL.test(urls[0]!) && isPostRequest(tokens);
}

/** An unlock covers only one explicit curl POST with a visible, literal JSON body. */
export function haUnlockAction(command: string): Unlock | undefined {
    if (/\$\(|`/.test(command)) return undefined;
    const tokens = shellTokens(command);
    if (!tokens || !/^(?:[A-Za-z0-9_./-]+\/)?curl$/.test(tokens[0] ?? "")) return undefined;
    let url = "", method = "", body: string | undefined;
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (/^-[fsS]+$/.test(token) || ["--fail", "--silent", "--show-error"].includes(token)) continue;
        const option = token.match(/^(--request|--header|--data|--data-raw|--data-binary|--json)(?:=(.*))?$|^(-[XHd])(.*)$/);
        if (option) {
            const name = option[1] ?? option[3]!;
            const value = option[2] ?? (option[4] || tokens[++i]);
            if (value === undefined) return undefined;
            if (name === "-X" || name === "--request") {
                if (method) return undefined;
                method = value;
            } else if (name === "-H" || name === "--header") {
                if (!/^(?:Authorization: Bearer [^\r\n]+|Content-Type: application\/json)$/i.test(value)) return undefined;
            } else {
                if (body !== undefined) return undefined;
                body = value;
            }
            continue;
        }
        if (url || !/^(?:https:\/\/(?:hass|home-assistant)\.janpuc\.com|\$HA_URL|\$\{HA_URL\})\/api\/services\/(?:homeassistant\/restart|update\/install)$/.test(token)) return undefined;
        url = token;
    }
    if (!url || method !== "POST") return undefined;
    let data: unknown;
    try { data = body === undefined ? {} : JSON.parse(body); } catch { return undefined; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const payload = data as Record<string, unknown>;
    if (url.endsWith("/homeassistant/restart"))
        return Object.keys(payload).length === 0 ? "ha-restart" : undefined;
    if (typeof payload.entity_id !== "string" || !/^update\.[a-z0-9_]+$/.test(payload.entity_id) ||
        Object.keys(payload).some((key) => !["entity_id", "backup"].includes(key)) ||
        (Object.hasOwn(payload, "backup") && payload.backup !== true)) return undefined;
    return "ha-update";
}

function consumeGrant(conversationId: unknown, action: Unlock): boolean {
    const key = JSON.stringify([conversationId, action]);
    const grant = grants.get(key);
    if (!grant) return false;
    if (grant.expiresAt <= Date.now() || grant.remaining <= 0) {
        grants.delete(key);
        return false;
    }
    if (--grant.remaining === 0) grants.delete(key);
    return true;
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

function sharedChangeForm(command: string, dryRun: boolean, original: string = command): string | undefined {
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
    if (GH_PR_REVIEW.test(command) && !ghPrReviewCommentAllowed(original)) return "write to GitHub";
    if (GH_COMMENT.test(command) && !ghCommentAllowed(original)) return "write to GitHub";
    for (const [what, re] of RULES) if (re.test(command)) return what;
    const calls = [...command.matchAll(GH_API)].map((m) => m[1]!);
    const originalCalls = [...original.matchAll(GH_API)].map((m) => m[1]!);
    for (const [index, args] of calls.entries()) {
        // The quote-stripped pass splits a quoted value with spaces into extra words, so the allow list
        // judges the real text of the same call. A call only this pass can see is judged as it is.
        const real = originalCalls.length === calls.length ? originalCalls[index]! : args;
        if (/^\s*graphql\b/.test(args)) {
            if (/\bmutation\b/.test(args!)) return "write to GitHub";
            continue;
        }
        const writeMethod = /(?:-X|--method)[\s=]*(?:POST|PUT|PATCH|DELETE)\b/i.test(args!);
        const readMethod = /(?:-X|--method)[\s=]*(?:GET|HEAD)\b/i.test(args!);
        const body = /\s(?:-[fF]\S+|-f|-F|--field|--raw-field|--input)(?=$|[\s=])/.test(args!) ||
            /\s--(?:field|raw-field|input)=\S*/.test(args!);
        if ((writeMethod || (!readMethod && body)) && !ghApiWriteAllowed(real)) return "write to GitHub";
    }
    return undefined;
}

const NO_APPROVAL =
    "This action is not allowed for agents and nobody was asked. If it is really needed, write the exact command and why " +
    "on a line starting `Jan:` in your answer or PR body. Never try another way around it.";

const OWN_PR_FORM =
    "Closing, reopening or editing your own PR works only as one command on its own, with the repository named: " +
    "`gh pr close <N> -R janpuc/<repo> --comment \"why\"` (no cd, &&, ; or pipes).";

export default function createApprovals(host: object) {
    void host;
    return defineExtension({
        name: "approvals",
        sections: [
            section(
                "shared_system_approvals",
                () =>
                    "Agents never ask for approval to run bash commands. Listed non-destructive writes run directly. Destructive or unlisted writes are blocked and nobody is asked by this hook. Home may use ask_jan with unlock for a Home Assistant restart or update window. Only the fixed Yes grants bounded access in that conversation. Alerts and PRs never call ask_jan. If a blocked action is really needed, write the exact command and why on a line starting `Jan:` in your answer or PR body. Never try another way around it.",
            ),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, _context) => {
                    if (call.name !== "bash") return undefined;
                    const command = String((call.arguments as { command?: unknown }).command ?? "");
                    const change = sharedChange(command);
                    if (!change) return undefined;
                    if (change === "call a Home Assistant service") {
                        const action = haUnlockAction(command);
                        if (action && consumeGrant(api.conversationId, action)) return undefined;
                    }
                    const subject = command.trim().replace(/[\r\n]+/g, " ");
                    if (change === "push git commits" && RAW_GIT_PUSH.test(command))
                        return { block: `Raw \`git push\` is blocked. Publish the branch with \`agent-push\`. ${NO_APPROVAL} Call: ${subject}` };
                    if (change === "write to GitHub" && HAND_BUILT_COMMIT.test(command))
                        return { block: `Hand-built GitHub commits and refs are blocked. Publish with \`agent-push\`. ${NO_APPROVAL} Call: ${subject}` };
                    // GitHub decides whether this is the agent's own PR. Any failed lookup fails closed.
                    const own = change === "write to GitHub" ? ownPrCandidate(command) : undefined;
                    if (own && (await prAuthorIsAgent(own.pr, own.repo))) return undefined;
                    const ownForm = /\bgh\s+pr\s+(?:close|reopen|edit)\b/.test(command) ? ` ${OWN_PR_FORM}` : "";
                    return { block: `${explain(command, change)}${ownForm} ${NO_APPROVAL} Call: ${subject}` };
                },
            }),
        ],
    });
}
