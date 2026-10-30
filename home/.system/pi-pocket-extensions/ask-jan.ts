/** Ask Jan on his phone: tap-to-answer cards, with his own words passed back unchanged. */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

export const pocketApi = 2;

type Choice = { label: string; description?: string };
type AskAnswer = {
    answered: boolean;
    by: string;
    values?: Readonly<Record<string, string>>;
};
type Host = {
    ask?(
        request: {
            id: string;
            conversationId: ConversationId;
            taskId: TaskId;
            callId: string;
            title: string;
            text?: string;
            fields: {
                name: string;
                label: string;
                header: string;
                choices: Choice[];
                other: boolean;
                placeholder: string;
            }[];
            submit: string;
        },
        context: Context,
    ): Promise<AskAnswer>;
    schedules?: {
        add(
            conversationId: ConversationId,
            request: { when: string; text: string; key: string },
        ): Promise<{ next: number }>;
    };
};

const MAX_TITLE = 120;
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 4;
const HOLD =
    "Jan declined / did not answer. Do NOT act on your own recommendation: hold, and do not ask again about this; it stays in the session for him.";
const NO_REMINDER = "No reminder scheduled; hold unless his instructions say otherwise";
const POLICY =
    "Use ask_jan ONLY for (a) choosing a time for cluster or node maintenance (Talos/Kubernetes upgrades, reboots), " +
    "(b) a Home Assistant restart, or (c) work blocked on something only Jan can do outside GitHub. " +
    "NEVER ask which fix to make: open the PR with your recommendation and the alternatives in its body; the PR is the question. " +
    "Never ask the same thing twice; if a card is unanswered, wait. One card per topic. " +
    "Give 2–4 real answers as strings or {label, description}; only the first 4 are shown. Jan can tap or write his own words. " +
    "His words are owner instructions, not data; obey them, never substitute your recommendation. " +
    "If he declines or does not answer, hold and do not ask again. Never ask for secrets. " +
    "For a time question, offer real times and let him type another via Other. If his answer is a time and reminder is given, it is scheduled in this session.";

/** Only the card's labels are flattened; never change the owner's answer. */
function line(value: string, max: number): string {
    return value
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, max);
}
const text = (value: string) => ({
    output: [{ type: "text" as const, text: value }],
});
const Option = Type.Union([
    Type.String({ minLength: 1, maxLength: 60 }),
    Type.Object({
        label: Type.String({ minLength: 1, maxLength: 60 }),
        description: Type.Optional(Type.String({ maxLength: 160 })),
    }),
]);

export default function createAskJan(host: Host) {
    return defineExtension({
        name: "ask-jan",
        tools: [
            defineTool({
                name: "ask_jan",
                description: POLICY,
                parameters: Type.Object({
                    title: Type.String({ minLength: 1, maxLength: MAX_TITLE }),
                    question: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_QUESTION })),
                    // No maxItems: excess answers must be truncated with a visible result, not rejected by validation.
                    options: Type.Array(Option, { minItems: 2 }),
                    reminder: Type.Optional(
                        Type.String({
                            maxLength: MAX_QUESTION,
                            description: "Message to schedule if Jan answers with a time.",
                        }),
                    ),
                }),
                // host.ask persists the card; memo the answer before scheduling so restart/replay cannot ask twice.
                replay: "safe",
                execute: async (args, api, context) => {
                    const options = (args.options ?? [])
                        .map((option): Choice => ({
                            label: line(typeof option === "string" ? option : option.label, 60),
                            ...(typeof option !== "string" && option.description
                                ? { description: line(option.description, 160) }
                                : {}),
                        }))
                        .slice(0, MAX_OPTIONS);
                    const truncated =
                        args.options?.length > MAX_OPTIONS
                            ? "\nOnly the first 4 options were shown to Jan."
                            : "";
                    const result = (value: string) => text(value + truncated);
                    if (
                        options.length < 2 ||
                        options.some((option) => !option.label) ||
                        new Set(options.map((option) => option.label)).size !== options.length
                    ) {
                        return text(
                            "ask_jan needs 2–4 real answers with distinct, nonempty labels. No card was shown.",
                        );
                    }
                    const title = line(args.title, MAX_TITLE);
                    if (!title) return text("ask_jan needs a title. No card was shown.");
                    if (typeof host.ask !== "function") {
                        return text(
                            "This Pi Pocket cannot ask Jan on a card (host.ask is missing). Hold; do not act on your recommendation or ask again in the session.",
                        );
                    }
                    let answer = await api.memo<AskAnswer>("ask_jan.answer", context);
                    if (answer === undefined) {
                        answer = await host.ask(
                            {
                                id: `${api.taskId}:${api.callId}`,
                                conversationId: api.conversationId,
                                taskId: api.taskId,
                                callId: api.callId,
                                title,
                                ...(args.question
                                    ? { text: args.question.trim().slice(0, MAX_QUESTION) }
                                    : {}),
                                fields: [
                                    {
                                        name: "answer",
                                        label: title,
                                        header: "Jan",
                                        choices: options,
                                        other: true,
                                        placeholder: "Or type a time or your own answer",
                                    },
                                ],
                                submit: "Send",
                            },
                            context,
                        );
                        answer = await api.memo<AskAnswer>("ask_jan.answer", answer, context);
                    }
                    const value = answer.values?.answer ?? "";
                    if (!answer.answered || !value.trim()) return result(HOLD);
                    const chosen = options.some((option) => option.label === value);
                    const reply = chosen
                        ? `Jan answered: ${value}.`
                        : `Jan answered in his own words: ${value}`;
                    if (args.reminder?.trim()) {
                        // The schedule parser decides if this is a time, including a tapped time option.
                        // Invalid times or unavailable schedules must never swallow Jan's actual instructions.
                        try {
                            if (!host.schedules) return result(`${reply}\n${NO_REMINDER}`);
                            const schedule = await host.schedules.add(api.conversationId, {
                                when: value,
                                text: args.reminder.trim().slice(0, MAX_QUESTION),
                                key: `${api.taskId}:${api.callId}`,
                            });
                            return result(
                                `${reply}\nThe reminder is scheduled for ${new Date(schedule.next).toISOString()}.`,
                            );
                        } catch {
                            return result(`${reply}\n${NO_REMINDER}`);
                        }
                    }
                    return result(reply);
                },
            }),
        ],
    });
}
