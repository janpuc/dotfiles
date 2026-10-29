/** Ask Jan on his phone: a question on a card in the session, answered in the app. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// Pi Pocket 0.19 renamed a tool result's `content` to `output`; this drop-in needs that.
export const pocketApi = 2;

type AskField = { name: string; label: string; placeholder?: string; autocomplete?: string };
type AskAnswer = { answered: boolean; by: string; values?: Record<string, string> };
type Schedule = { id: string; next: number; text: string; zone?: string };
type Host = {
    /**
     * Pi Pocket 0.22.0 and newer: a card in the session, the same push as an approval, and
     * the answer to this extension alone. Without it there is no card and no push.
     */
    ask?(
        request: {
            id: string;
            conversationId: number;
            taskId: number;
            callId: string;
            title: string;
            text?: string;
            fields?: AskField[];
            submit?: string;
        },
        context: unknown,
    ): Promise<AskAnswer>;
    /** The schedules extension: Pi's own scheduled messages (since 0.19.0). */
    schedules?: {
        add(
            conversationId: number,
            request: { when: string; text: string; key: string },
        ): Promise<Schedule>;
    };
};

const MAX_TITLE = 120;
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 6;
// Pi Pocket's own limits: a field's name, its label and its autocomplete.
const AUTOCOMPLETE = /^[a-z][a-z0-9 -]{0,39}$/;

/** One line, at most `max` characters: a card's title and labels are single lines. */
function line(value: unknown, max: number): string {
    return String(value ?? "")
        .replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, max);
}

/** The options as one autocomplete hint: lower case letters, digits, spaces and dashes. */
function hint(options: string[]): string | undefined {
    const value = options
        .join(" ")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    return AUTOCOMPLETE.test(value) ? value : undefined;
}

function text(value: string) {
    return { output: [{ type: "text" as const, text: value }] };
}

export default function createAskJan(host: Host) {
    return defineExtension({
        name: "ask-jan",
        tools: [
            defineTool({
                name: "ask_jan",
                description:
                    "Ask Jan a question he has to answer on his phone: the question shows as a card in this session and " +
                    "he gets the same push as an approval. Use it for a decision only he can make, and only when the " +
                    "answer changes what you do next: when to merge a Talos or Kubernetes upgrade, whether to port an " +
                    "upstream change, when to touch the cluster. Give the answers as options. If he answers with a time " +
                    "and you passed a reminder, that reminder is scheduled in this session for the time he named. " +
                    "His answer never reaches the transcript: you learn which option he chose, not what he wrote. Never " +
                    "ask him for a secret, and never ask what you can read or decide yourself.",
                parameters: Type.Object({
                    title: Type.String({
                        minLength: 1,
                        maxLength: MAX_TITLE,
                        description: "One line: what he is asked.",
                    }),
                    question: Type.Optional(
                        Type.String({
                            minLength: 1,
                            maxLength: MAX_QUESTION,
                            description: "The detail he reads on the card.",
                        }),
                    ),
                    options: Type.Optional(
                        Type.Array(Type.String({ maxLength: 60 }), { maxItems: MAX_OPTIONS }),
                    ),
                    reminder: Type.Optional(
                        Type.String({
                            maxLength: MAX_QUESTION,
                            description:
                                "The message to schedule in this session if he answers with a time, such as 'Jan: merge #1595 now'.",
                        }),
                    ),
                }),
                // Not safe to replay: a card that was cut off asks again.
                execute: async (args, api, context) => {
                    if (typeof host.ask !== "function") {
                        return text(
                            "This Pi Pocket cannot ask Jan on a card (host.ask is missing). Ask him in the session instead.",
                        );
                    }
                    const title = line(args.title, MAX_TITLE);
                    if (!title) return text("ask_jan needs a title.");
                    const question = String(args.question ?? "").trim().slice(0, MAX_QUESTION);
                    const options = (args.options ?? [])
                        .map((option) => line(option, 60))
                        .filter(Boolean)
                        .slice(0, MAX_OPTIONS);
                    const reminder =
                        args.reminder === undefined
                            ? undefined
                            : String(args.reminder).trim().slice(0, MAX_QUESTION);
                    const autocomplete = hint(options);
                    const label = line(
                        options.length ? `Your answer: ${options.join(", ")}` : "Your answer",
                        80,
                    );
                    const answer = await host.ask(
                        {
                            id: `${api.taskId}:${api.callId}`,
                            conversationId: api.conversationId,
                            taskId: api.taskId,
                            callId: api.callId,
                            title,
                            ...(question ? { text: question } : {}),
                            fields: [
                                {
                                    name: "answer",
                                    label,
                                    placeholder: options[0] ?? "now, or a time",
                                    ...(autocomplete ? { autocomplete } : {}),
                                },
                            ],
                            submit: "Send",
                        },
                        context,
                    );
                    if (!answer.answered) return text(`${answer.by} declined the question.`);
                    const value = String(answer.values?.answer ?? "").trim();
                    const chosen = options.find(
                        (option) => option.toLowerCase() === value.toLowerCase(),
                    );
                    if (chosen) return text(`Jan answered: ${chosen}.`);
                    if (reminder && value) {
                        if (!host.schedules) {
                            return text(
                                "Jan answered with a time, but this Pi Pocket cannot schedule messages. Schedule it yourself in the session.",
                            );
                        }
                        const schedule = await host.schedules.add(api.conversationId, {
                            when: value,
                            text: reminder,
                            key: `${api.taskId}:${api.callId}`,
                        });
                        return text(
                            `Jan answered with a time; the reminder is scheduled for ${new Date(schedule.next).toISOString()}.`,
                        );
                    }
                    return text(
                        "Jan answered with something this tool does not pass on. Ask him in the session.",
                    );
                },
            }),
        ],
    });
}
