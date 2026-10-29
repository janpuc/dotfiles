// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/ask-jan.test.ts
// Fakes mirror Pi Pocket v0.26.0 / pi-durable 1.4.0's tool API and host.ask.
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

const api = { conversationId: 42, taskId: 7, callId: "call-1" };
const context = {};

// A host that answers the card the way Jan would, and remembers what it was asked.
function host(answer: { answered: boolean; by: string; values?: Record<string, string> }) {
    const asked: any[] = [];
    const scheduled: any[] = [];
    const built = {
        ask: async (request: any, ctx: unknown) => {
            assert.equal(ctx, context);
            asked.push(request);
            return answer;
        },
        schedules: {
            add: async (conversationId: number, request: any) => {
                scheduled.push({ conversationId, request });
                return { id: "s1", next: Date.parse("2026-11-02T09:00:00Z"), text: request.text, zone: "UTC" };
            },
        },
    };
    return { host: built, asked, scheduled };
}

test("ask-jan drop-in declares extension API 2 and one tool", () => {
    assert.equal(pocketApi, 2);
    const extension = create({});
    assert.equal(extension.name, "ask-jan");
    assert.deepEqual(extension.tools.map((tool) => tool.name), ["ask_jan"]);
});

test("ask_jan asks on a card and returns the chosen option, never his words", async () => {
    const h = host({ answered: true, by: "Jan", values: { answer: "now" } });
    const extension = create(h.host);
    const tool = extension.tools[0];
    const result = await tool.execute(
        { title: "Talos 1.14.5 is ready", question: "Upstream merged it on 2026-10-26.", options: ["now", "hold"] },
        api,
        context,
    );
    assert.equal(result.output[0].text, "Jan answered: now.");
    assert.equal(h.asked.length, 1);
    const request = h.asked[0];
    assert.equal(request.id, "7:call-1");
    assert.equal(request.conversationId, 42);
    assert.equal(request.taskId, 7);
    assert.equal(request.callId, "call-1");
    assert.equal(request.title, "Talos 1.14.5 is ready");
    assert.equal(request.text, "Upstream merged it on 2026-10-26.");
    assert.equal(request.fields.length, 1);
    assert.equal(request.fields[0].name, "answer");
    assert.match(request.fields[0].autocomplete, /^[a-z][a-z0-9 -]{0,39}$/);
    assert.equal(h.scheduled.length, 0, "an option is not a time");
});

test("ask_jan schedules the reminder when Jan answers with a time", async () => {
    const h = host({ answered: true, by: "Jan", values: { answer: "tomorrow 9:00" } });
    const extension = create(h.host);
    const result = await extension.tools[0].execute(
        { title: "When?", question: "Reply with a time, or now.", options: ["now"], reminder: "Jan: merge #1595 now" },
        api,
        context,
    );
    assert.match(result.output[0].text, /reminder is scheduled for 2026-11-02T09:00:00.000Z/);
    assert.equal(h.scheduled.length, 1);
    assert.equal(h.scheduled[0].conversationId, 42);
    assert.equal(h.scheduled[0].request.when, "tomorrow 9:00");
    assert.equal(h.scheduled[0].request.text, "Jan: merge #1595 now");
});

test("ask_jan says what happened when Jan declines or writes something else", async () => {
    const declined = host({ answered: false, by: "Jan" });
    const extension = create(declined.host);
    const result = await extension.tools[0].execute({ title: "When?" }, api, context);
    assert.equal(result.output[0].text, "Jan declined the question.");

    const other = host({ answered: true, by: "Jan", values: { answer: "do not port the Intel bits" } });
    const extension2 = create(other.host);
    const result2 = await extension2.tools[0].execute({ title: "Port it?", options: ["yes", "no"] }, api, context);
    assert.equal(result2.output[0].text, "Jan answered with something this tool does not pass on. Ask him in the session.");
    assert.doesNotMatch(result2.output[0].text, /Intel/);
});

test("ask_jan without host.ask says so instead of failing", async () => {
    const extension = create({});
    const result = await extension.tools[0].execute({ title: "When?" }, api, context);
    assert.match(result.output[0].text, /cannot ask Jan on a card/);
});
