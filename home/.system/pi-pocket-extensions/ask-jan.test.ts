// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/ask-jan.test.ts
// Fakes mirror Pi Pocket v0.27.0-beta.7 / pi-durable 1.4.0's tool API and host.ask.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const durable = `
export const defineExtension = x => x;
export const defineTool = x => x;
`;
const ai = `export const Type = {
    Object: properties => ({type:'object', properties}),
    String: options => ({type:'string', ...options}),
    Array: (items, options) => ({type:'array', items, ...options}),
    Union: items => ({anyOf:items}),
    Optional: schema => schema
};`;
const dataUrl = (source: string) =>
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const imports = registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "@earendil-works/pi-durable")
            return { url: dataUrl(durable), shortCircuit: true };
        if (specifier === "@earendil-works/pi-ai") return { url: dataUrl(ai), shortCircuit: true };
        return next(specifier, context);
    },
});
const source = await readFile(new URL("./ask-jan.ts", import.meta.url), "utf8");
const { default: create, pocketApi } = await import(dataUrl(stripTypeScriptTypes(source)));
imports.deregister();

function api() {
    const memo = new Map();
    return {
        conversationId: 42,
        taskId: 7,
        callId: "call-1",
        memo: async (key: string, value: unknown, ctx?: unknown) => {
            if (ctx !== undefined) memo.set(key, value);
            return memo.get(key);
        },
    };
}
const context = {};
const options = ["now", { label: "hold", description: "Do not restart yet" }];
function host(answer: { answered: boolean; by: string; values?: Record<string, string> }) {
    const asked: any[] = [];
    const scheduled: any[] = [];
    return {
        asked,
        scheduled,
        host: {
            ask: async (request: any, ctx: unknown) => {
                assert.equal(ctx, context);
                asked.push(request);
                return answer;
            },
            schedules: {
                add: async (conversationId: number, request: any) => {
                    scheduled.push({ conversationId, request });
                    return { next: Date.parse("2026-11-02T09:00:00Z") };
                },
            },
        },
    };
}
const run = (h: any, args: any, a = api()) => create(h).tools[0].execute(args, a, context);

test("ask-jan declares API 2, safe replay, and only ask_jan", () => {
    assert.equal(pocketApi, 2);
    const extension = create({});
    assert.equal(extension.name, "ask-jan");
    assert.deepEqual(
        extension.tools.map((tool) => tool.name),
        ["ask_jan"],
    );
    assert.equal(extension.tools[0].replay, "safe");
    assert.match(extension.tools[0].description, /ONLY/);
    assert.match(extension.tools[0].description, /NEVER ask which fix/);
});

test("ask_jan sends tappable choices and descriptions with Other", async () => {
    const h = host({ answered: true, by: "Jan", values: { answer: "now" } });
    const result = await run(h.host, {
        title: "Restart HA?",
        question: "Eight switches stop during restart.",
        options,
    });
    assert.equal(result.output[0].text, "Jan answered: now.");
    assert.deepEqual(h.asked[0], {
        id: "7:call-1",
        conversationId: 42,
        taskId: 7,
        callId: "call-1",
        title: "Restart HA?",
        text: "Eight switches stop during restart.",
        submit: "Send",
        fields: [
            {
                name: "answer",
                label: "Restart HA?",
                header: "Jan",
                choices: [{ label: "now" }, { label: "hold", description: "Do not restart yet" }],
                other: true,
                placeholder: "Or type a time or your own answer",
            },
        ],
    });
    assert.equal(h.scheduled.length, 0);
});

test("ask_jan passes owner words verbatim, including whitespace and newlines", async () => {
    const words = "  NO — do the opposite.\nKeep it as it is!  ";
    const h = host({ answered: true, by: "Jan", values: { answer: words } });
    const result = await run(h.host, { title: "Restart?", options });
    assert.equal(result.output[0].text, `Jan answered in his own words: ${words}`);
});

test("ask_jan holds on decline, missing or blank answer", async () => {
    for (const answer of [
        { answered: false, by: "Jan" },
        { answered: true, by: "Jan" },
        { answered: true, by: "Jan", values: { answer: "  " } },
    ]) {
        const h = host(answer);
        const result = await run(h.host, { title: "Restart?", options });
        assert.equal(
            result.output[0].text,
            "Jan declined / did not answer. Do NOT act on your own recommendation: hold, and do not ask again about this; it stays in the session for him.",
        );
        assert.equal(h.scheduled.length, 0);
    }
});

test("ask_jan shows only the first four options and reports truncation", async () => {
    const h = host({ answered: true, by: "Jan", values: { answer: "a" } });
    const result = await run(h.host, {
        title: "When?",
        options: ["a", "b", "c", "d", "e"],
    });
    assert.deepEqual(
        h.asked[0].fields[0].choices.map((x) => x.label),
        ["a", "b", "c", "d"],
    );
    assert.equal(
        result.output[0].text,
        "Jan answered: a.\nOnly the first 4 options were shown to Jan.",
    );
});

test("ask_jan schedules typed and tapped times, preserving the answer", async () => {
    for (const choices of [
        ["now", "hold"],
        ["tomorrow 9:00", "hold"],
    ]) {
        const h = host({
            answered: true,
            by: "Jan",
            values: { answer: "tomorrow 9:00" },
        });
        const result = await run(h.host, {
            title: "When?",
            options: choices,
            reminder: "Jan: merge #1595 now",
        });
        assert.match(result.output[0].text, /Jan answered.*tomorrow 9:00/);
        assert.match(result.output[0].text, /reminder is scheduled for 2026-11-02T09:00:00.000Z/);
        assert.deepEqual(h.scheduled, [
            {
                conversationId: 42,
                request: {
                    when: "tomorrow 9:00",
                    text: "Jan: merge #1595 now",
                    key: "7:call-1",
                },
            },
        ]);
    }
});

test("ask_jan keeps Jan's instructions when reminder parsing fails or schedules are absent", async () => {
    const words = " do not restart!\nI mean it ";
    for (const schedules of [
        undefined,
        {
            add: async () => {
                throw new Error("Not a time");
            },
        },
    ]) {
        const h = host({ answered: true, by: "Jan", values: { answer: words } });
        h.host.schedules = schedules;
        const result = await run(h.host, {
            title: "When?",
            options,
            reminder: "Restart",
        });
        assert.equal(
            result.output[0].text,
            `Jan answered in his own words: ${words}\nNo reminder scheduled; hold unless his instructions say otherwise`,
        );
    }
});

test("ask_jan requires at least two distinct real answers without creating a card", async () => {
    for (const choices of [undefined, [], ["now"], ["now", "now"], ["now", "  "]]) {
        const h = host({ answered: false, by: "Jan" });
        const result = await run(h.host, { title: "When?", options: choices });
        assert.match(result.output[0].text, /needs 2–4 real answers/);
        assert.equal(h.asked.length, 0);
    }
});

test("ask_jan without host.ask holds instead of asking again", async () => {
    const result = await run({}, { title: "When?", options });
    assert.match(result.output[0].text, /host.ask is missing/);
    assert.match(result.output[0].text, /Hold; do not act/);
});

test("ask_jan memoizes the owner's answer across replay without a second card", async () => {
    const h = host({ answered: true, by: "Jan", values: { answer: "hold" } });
    const a = api();
    const args = { title: "Restart?", options };
    assert.deepEqual(await run(h.host, args, a), await run(h.host, args, a));
    assert.equal(h.asked.length, 1);
});
