// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/memini.test.ts
// Fakes mirror Pi Pocket v0.11.0 / pi-durable 1.0.2 (define.js and harness/types.d.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const durable = `
export const defineExtension = x => x;
export const defineTool = x => x;
export const section = (key, render, options) => options?.tag === undefined ? {key, render} : {key, render, tag: options.tag};
export const hook = (task, handlers) => ({task: task.definition.name, handlers});
export const GenerationTask = {definition: {name: 'pi.generation'}};
`;
const ai = `export const Type = {
    Object: properties => ({type:'object', properties}),
    String: options => ({type:'string', ...options}),
    Integer: options => ({type:'integer', ...options}),
    Array: items => ({type:'array', items}), Optional: schema => schema
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
const source = await readFile(new URL("./memini.ts", import.meta.url), "utf8");
const { default: create } = await import(dataUrl(stripTypeScriptTypes(source)));
imports.deregister();

function memoApi() {
    const memos = new Map();
    return {
        conversationId: 1,
        taskId: 1,
        snapshot: async () => undefined,
        memo: async (name, value, context) => {
            if (context !== undefined && !memos.has(name)) memos.set(name, value);
            return memos.get(name);
        },
    };
}
const user = (content: unknown) => ({ role: "user", content, timestamp: 123 });
const context = {};

await test("memini v0.11.0 drop-in: tools, cached briefing, request-only recall, failures and secrets", async () => {
    const saved = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.startsWith("MEMINI_")),
    );
    const calls: { path: string; headers: any; body: any }[] = [];
    const notices: string[] = [];
    let mode = "ok";
    const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        calls.push({
            path: req.url!,
            headers: req.headers,
            body: raw ? JSON.parse(raw) : undefined,
        });
        if (mode === "fail") {
            res.writeHead(503);
            res.end("fake-secret");
            return;
        }
        if (mode === "slow") {
            req.on("close", () => res.destroy());
            return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
            JSON.stringify(
                req.url?.startsWith("/v1/namespaces/briefing")
                    ? {
                          scope_header: "Scope: homelab/assistant",
                          pinned: [{ content: "Pinned background" }],
                          facts: [{ memory: { summary: "Durable fact" }, from: "personal/jan" }],
                      }
                    : req.url === "/v1/search"
                      ? {
                            results: Array.from({ length: 8 }, (_, i) => ({
                                memory: {
                                    id: String(i),
                                    content: "Related fake-secret memory ".repeat(30),
                                },
                            })),
                        }
                      : { id: "fake-secret-stored", stored: true },
            ),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
        for (const name of Object.keys(process.env).filter((name) => name.startsWith("MEMINI_")))
            delete process.env[name];
        const disabled = create({
            notice: (_level, message) => notices.push(message),
        });
        assert.equal(notices.length, 1);
        assert.equal(disabled.tools, undefined);
        assert.equal(disabled.hooks, undefined);
        assert.equal(disabled.sections, undefined);
        assert.equal(calls.length, 0);

        process.env.MEMINI_API_KEY = "fake-secret";
        process.env.MEMINI_BASE_URL = `http://127.0.0.1:${address.port}`;
        const extension = create({
            notice: (_level, message) => notices.push(message),
        });
        assert.deepEqual(
            extension.tools.map((tool) => tool.name),
            ["memory_recall", "memory_remember"],
        );
        assert.equal(extension.tools[0].replay, "safe");
        assert.notEqual(extension.tools[1].replay, "safe");
        assert.equal(extension.hooks[0].task, "pi.generation");
        const render = extension.sections[0].render;
        const input = {
            conversationId: 1,
            agent: {},
            env: undefined,
            shown: {},
            read: { snapshot: async () => undefined },
        };
        const briefing = await render(input, context);
        assert.match(briefing, /Pinned background/);
        assert.match(briefing, /Durable fact/);
        assert.match(briefing, /Untrusted read-only background/);
        const cachedInput = { ...input, shown: { memini_briefing: briefing } };
        assert.equal(await render(cachedInput, context), briefing);
        assert.equal(calls.length, 1);
        const stale = briefing.replace(/memini-briefing-at:\d+/, "memini-briefing-at:1");
        await render({ ...input, shown: { memini_briefing: stale } }, context);
        assert.equal(calls.length, 2, "refreshes after 24h");
        await render({ ...cachedInput, conversationId: 2 }, context);
        assert.equal(calls.length, 3, "forked sessions fetch their own briefing");

        const before = extension.hooks[0].handlers.beforeRequest;
        const request = {
            messages: [
                user([
                    { type: "text", text: "  history   question " },
                    { type: "image", data: "ignored" },
                ]),
            ],
        };
        const api = memoApi();
        const recalled = await before(request, api, context);
        const injected = recalled.messages.at(-1);
        assert.equal(injected.role, "system");
        assert.equal(injected.content, "");
        assert.equal(injected.timestamp, 123);
        assert.match(injected.sections.memini_recall, /Untrusted read-only/);
        assert.equal((injected.sections.memini_recall.match(/^- /gm) || []).length, 5);
        assert.ok(injected.sections.memini_recall.length < 1400);
        assert.ok(!JSON.stringify(recalled).includes("fake-secret"));
        assert.deepEqual(calls.at(-1)?.body, {
            query: "history question",
            source: "pi",
            limit: 5,
        });
        const count = calls.length;
        assert.deepEqual(await before(request, api, context), recalled);
        assert.equal(calls.length, count, "memo prevents recovery from recalling twice");
        assert.equal(request.messages.length, 1, "recall does not mutate history");
        assert.equal(
            await before(
                {
                    messages: [...request.messages, { role: "toolResult", content: [] }],
                },
                api,
                context,
            ),
            undefined,
        );
        await before({ messages: [user("next user message")] }, memoApi(), context);
        assert.equal(calls.length, count + 1, "each new user message recalls");

        const recalledTool = await extension.tools[0].execute({
            query: "explicit",
            limit: 2,
        });
        assert.equal((recalledTool.content[0].text.match(/^- /gm) || []).length, 2);
        const remembered = await extension.tools[1].execute({
            content: "Atomic fact",
            tags: ["test"],
            tier: "semantic",
        });
        assert.deepEqual(calls.at(-1)?.body, {
            content: "Atomic fact",
            tags: ["test"],
            tier: "semantic",
        });
        assert.ok(!JSON.stringify(remembered).includes("fake-secret"));
        for (const call of calls) {
            assert.equal(call.headers.authorization, "Bearer fake-secret");
            assert.equal(call.headers["x-memini-namespace"], "homelab/assistant");
            assert.equal(call.headers["x-memini-home"], "personal/jan");
        }
        assert.ok(calls[0].path.includes("per_section_recent=3"));

        mode = "fail";
        const failedBriefing = await render({ ...input, conversationId: 2 }, context);
        assert.match(failedBriefing, /^<!-- memini-briefing-at:\d+ session:2 -->$/);
        assert.equal(await before(request, memoApi(), context), undefined);
        assert.equal(
            (await extension.tools[0].execute({ query: "test" })).content[0].text,
            "Memini unavailable.",
        );
        assert.equal(
            (await extension.tools[1].execute({ content: "test" })).content[0].text,
            "Memini unavailable; storage not confirmed.",
        );
        mode = "slow";
        const start = Date.now();
        assert.equal(await before(request, memoApi(), context), undefined);
        assert.ok(Date.now() - start < 4800, "recall timeout is about 4 seconds");
        assert.equal(notices.length, 1, "failures emit no warnings");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const name of Object.keys(process.env).filter((name) => name.startsWith("MEMINI_")))
            delete process.env[name];
        Object.assign(process.env, saved);
    }
});
