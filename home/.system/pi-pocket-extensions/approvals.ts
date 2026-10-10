/** Ask Jan on his phone before bash commands change shared systems. */
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

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
const OPTS = String.raw`(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ][^\s;&|-]\S*)?)*`;
const cmd = (tool: string, verbs: string) =>
    new RegExp(String.raw`(?:^|[\s;&|(\x60/])${tool}${OPTS}\s+(?:${verbs})(?=$|[\s;&|)])`);
const RULES: [string, RegExp][] = [
    ["push git commits", cmd("git", "push")],
    ["merge a GitHub PR", cmd("gh", String.raw`pr\s+merge`)],
    [
        "write to GitHub",
        cmd(
            "gh",
            String.raw`pr\s+(?:merge|close|reopen|comment|review|create|edit|ready|lock|unlock)|issue\s+(?:create|close|reopen|comment|edit|delete|transfer|lock|pin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|(?:secret|variable|label)\s+(?:set|create|edit|delete)`,
        ),
    ],
    [
        "change the cluster",
        cmd(
            "kubectl",
            String.raw`apply|create|delete|patch|replace|scale|edit|label|annotate|cordon|uncordon|drain|taint|autoscale|expose|run|set|rollout\s+(?:restart|undo|pause|resume)`,
        ),
    ],
    [
        "change Flux",
        cmd("flux", "reconcile|suspend|resume|create|delete|bootstrap|install|uninstall|push|tag"),
    ],
    [
        "change a Talos node",
        cmd(
            "talosctl",
            String.raw`apply-config|apply|upgrade|upgrade-k8s|reboot|reset|shutdown|edit|patch|bootstrap|rotate-ca|wipe|etcd\s+(?:remove-member|leave|forfeit-leadership|defrag)`,
        ),
    ],
    ["change a Helm release", cmd("helm", "install|upgrade|uninstall|rollback|delete")],
    ["apply or remove dotfiles", cmd("chezmoi", "apply|update|destroy|purge")],
];
const GH_API = /(?:^|[\s;&|(\x60/])gh\s+api\b([^;&|\n]*)/g;
const HTTP = /(?:^|[\s;&|(\x60/])(curl|wget|http|https|httpie)\b([^;&|\n]*)/g;
const HA_TARGET =
    /hass\.janpuc\.com|home-assistant\.janpuc\.com|\$HA_URL\b|\$\{HA_URL\}|\/api\/services\//i;

/** What the command would change, or undefined for reads. */
export function sharedChange(command: string): string | undefined {
    for (const [, tool, args] of command.replace(/\\\r?\n/g, " ").matchAll(HTTP)) {
        if (!HA_TARGET.test(args!)) continue;
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
    // Preserve the laptop guard's dry-run exemption for its original rules.
    if (/--dry-run(?!=none)\b/.test(command)) return undefined;
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
                    const subject = command.trim().replace(/[\r\n]+/g, " ");
                    const reason = `This command will ${change}. Ask Jan before running it.`;
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
