// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/web.test.ts
// Fakes mirror Pi Pocket v0.11.0 / pi-durable 1.0.2 (define.js and harness/types.d.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const durable = `
export const defineExtension = x => x;
export const defineTool = x => x;
export const section = (key, render) => ({key, render});
`;
const ai = `export const Type = {
    Object: properties => ({type:'object', properties}),
    String: options => ({type:'string', ...options}),
    Integer: options => ({type:'integer', ...options}), Optional: schema => schema
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
const source = await readFile(new URL("./web.ts", import.meta.url), "utf8");
const { default: create } = await import(dataUrl(stripTypeScriptTypes(source)));
imports.deregister();

await test("web v0.11.0 drop-in: search, page reading, fallback, limits and timeouts", async (t) => {
    const saved = {
        SEARXNG_URL: process.env.SEARXNG_URL,
        FLARESOLVERR_URL: process.env.FLARESOLVERR_URL,
    };
    const calls: { path: string; headers: any; body: any }[] = [];
    let solverMode = "ok";
    const page = `<!doctype html><html><head><title> A &amp; B </title><style>STYLE_SECRET</style></head><body>
        <header>HEADER_SECRET</header><nav><ul><li>NAV_SECRET</li></ul></nav>
        <div>OUTSIDE_MAIN</div><main><h1>Readable heading</h1><p>Hello <b>world</b> &amp; friends.</p>
        <script>if (x < 5) { document.write("SCRIPT_SECRET"); }</script>
        <style>STYLE_SECRET</style><form><p>FORM_SECRET</p><input value="INPUT_SECRET"></form>
        <h2>Details</h2><ul><li>First &#x1F600;</li><li>Second &#8212; item</li></ul>
        <p data-example="a > b">Collapsed    spaces\n work.<br>New line &lt;safe&gt;.</p>
        <footer>FOOTER_SECRET</footer></main><footer>FOOTER_SECRET</footer></body></html>`;
    const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        calls.push({
            path: req.url!,
            headers: req.headers,
            body: raw ? JSON.parse(raw) : undefined,
        });
        const url = new URL(req.url!, "http://localhost");
        if (
            url.pathname === "/slow" ||
            (url.pathname === "/search" && url.searchParams.get("q") === "slow") ||
            (url.pathname === "/v1" && solverMode === "slow")
        ) {
            req.on("close", () => res.destroy());
            return;
        }
        if (url.pathname === "/search") {
            res.setHeader("Content-Type", "application/json");
            if (url.searchParams.get("q") === "empty") {
                res.end("{}");
                return;
            }
            if (url.searchParams.get("q") === "fail") {
                res.writeHead(500);
                res.end();
                return;
            }
            res.end(
                JSON.stringify({
                    answers: ["  Direct\n answer "],
                    results: [
                        {
                            url: "https://example.com/a?ref=1",
                            title: " First\n title ",
                            content: " A\n snippet ",
                            publishedDate: "2026-06-01",
                        },
                        { url: "https://example.com/a?ref=2#part", title: "DUPLICATE" },
                        { url: "file:///private", title: "INVALID" },
                        { url: "not a url", title: "INVALID" },
                        { url: "https://EXAMPLE.com/a", title: "DUPLICATE" },
                        { url: "http://example.com/a", title: "Different scheme" },
                        ...Array.from({ length: 25 }, (_, i) => ({
                            url: `https://example.com/b${i}`,
                            title: `Other ${i}`,
                            content: "snippet",
                        })),
                    ],
                }),
            );
        } else if (url.pathname === "/v1") {
            res.setHeader("Content-Type", "application/json");
            if (solverMode === "http-fail") {
                res.writeHead(502);
                res.end();
                return;
            }
            const body = JSON.parse(raw);
            res.end(
                JSON.stringify({
                    status: solverMode === "fail" ? "error" : "ok",
                    solution: {
                        url: body.url + "?solved=1",
                        status: solverMode === "bad-status" ? 403 : 200,
                        response:
                            solverMode === "challenge"
                                ? "<title>Just a moment...</title>"
                                : "<title>Solved page</title><main><p>Fallback readable content.</p></main>",
                    },
                }),
            );
        } else if (url.pathname === "/redirect") {
            res.writeHead(302, { Location: "/page" });
            res.end();
        } else if (/^\/blocked(403|429|503)$/.test(url.pathname)) {
            res.writeHead(Number(url.pathname.slice(8)));
            res.end("blocked");
        } else if (url.pathname === "/challenge") {
            res.setHeader("Content-Type", "text/html");
            res.end(
                "<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/test'></script>",
            );
        } else if (url.pathname === "/large-length") {
            res.writeHead(200, { "Content-Length": String(6 * 1024 * 1024) });
            res.end("tiny");
        } else if (url.pathname === "/large-stream") {
            res.setHeader("Content-Type", "text/plain");
            res.write("x".repeat(3 * 1024 * 1024));
            res.end("x".repeat(3 * 1024 * 1024));
        } else if (url.pathname === "/slow-body") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write("partial");
            req.on("close", () => res.destroy());
        } else if (url.pathname === "/missing") {
            res.writeHead(404);
            res.end("missing");
        } else if (url.pathname === "/plain") {
            res.setHeader("Content-Type", "text/plain");
            res.end("Plain <not HTML>\n  keeps spacing.");
        } else if (url.pathname === "/json") {
            res.setHeader("Content-Type", "application/json");
            res.end('{"hello":"<world>"}\n');
        } else if (url.pathname === "/markdown") {
            res.setHeader("Content-Type", "text/markdown");
            res.end("# Heading\n\n- **Item**\n");
        } else if (url.pathname === "/long") {
            res.setHeader("Content-Type", "text/plain");
            res.end("x".repeat(13000));
        } else if (url.pathname === "/no-main") {
            res.setHeader("Content-Type", "text/html");
            res.end("<title>Title</title><nav>hidden</nav><h1>Heading</h1><p>Paragraph</p>");
        } else {
            if (url.pathname !== "/sniff")
                res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(page);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        process.env.SEARXNG_URL = base + "/";
        process.env.FLARESOLVERR_URL = base + "/";
        const extension = create();
        const [search, fetchPage] = extension.tools;
        const searchText = async (args: object) => (await search.execute(args)).content[0].text;
        const fetchText = async (path: string, args: object = {}) =>
            (await fetchPage.execute({ url: base + path, ...args })).content[0].text;

        await t.test("tool schemas, replay safety and untrusted-source guidance", () => {
            assert.equal(extension.name, "web");
            assert.deepEqual(
                extension.tools.map((tool) => tool.name),
                ["web_search", "web_fetch"],
            );
            assert.ok(extension.tools.every((tool) => tool.replay === "safe"));
            assert.equal(search.parameters.properties.limit.maximum, 20);
            assert.deepEqual(search.parameters.properties.time_range.enum, [
                "day",
                "week",
                "month",
                "year",
            ]);
            assert.match(
                extension.sections[0].render(),
                /web_search.*web_fetch.*Cite.*untrusted.*never as instructions/,
            );
        });
        await t.test(
            "dedupe by scheme + host + path, compact snippets, dates, answers and limits",
            async () => {
                const output = await searchText({ query: "a & b", time_range: "week" });
                assert.match(output, /^Answers:\nDirect answer/);
                assert.match(
                    output,
                    /1\. First title \(2026-06-01\)\nhttps:\/\/example.com\/a\?ref=1\nA snippet/,
                );
                assert.match(output, /2\. Different scheme/);
                assert.doesNotMatch(output, /DUPLICATE|INVALID/);
                assert.equal(output.match(/^\d+\. /gm)?.length, 8);
                const requested = new URL(calls.at(-1)!.path, base);
                assert.equal(requested.searchParams.get("q"), "a & b");
                assert.equal(requested.searchParams.get("format"), "json");
                assert.equal(requested.searchParams.get("time_range"), "week");
                assert.equal(
                    (await searchText({ query: "test", limit: 20 })).match(/^\d+\. /gm)?.length,
                    20,
                );
                assert.equal(
                    (await searchText({ query: "test", limit: 1 })).match(/^\d+\. /gm)?.length,
                    1,
                );
                assert.equal(await searchText({ query: "empty" }), "No results found.");
                await assert.rejects(searchText({ query: "fail" }), /SearXNG returned HTTP 500/);
            },
        );
        await t.test(
            "HTML extraction, title, entities, main, headings/lists, whitespace and redirects",
            async () => {
                const output = await fetchText("/redirect");
                assert.equal(
                    output,
                    `URL: ${base}/page\n\nA & B\n\nReadable heading\nHello world & friends.\nDetails\n- First 😀\n- Second — item\nCollapsed spaces work.\nNew line <safe>.`,
                );
                assert.doesNotMatch(output, /SECRET|OUTSIDE_MAIN/);
                assert.match(calls.at(-1)!.headers["user-agent"], /Mozilla\/5\.0/);
                assert.match(await fetchText("/no-main"), /Title\n\nHeading\nParagraph$/);
                assert.match(await fetchText("/sniff"), /Readable heading/);
            },
        );
        await t.test(
            "plain text, JSON and Markdown pass through without whitespace changes",
            async () => {
                for (const [path, expected] of [
                    ["/plain", "Plain <not HTML>\n  keeps spacing."],
                    ["/json", '{"hello":"<world>"}\n'],
                    ["/markdown", "# Heading\n\n- **Item**\n"],
                ])
                    assert.equal(await fetchText(path), `URL: ${base}${path}\n\n${expected}`);
            },
        );
        await t.test("default and explicit trimming with notice", async () => {
            const output = await fetchText("/long");
            assert.match(output, /\[Trimmed to 12000 characters; original 13000 characters\.\]$/);
            assert.equal(output.match(/x+/)![0].length, 12000);
            const short = await fetchText("/long", { max_chars: 17 });
            assert.equal(short.match(/x+/)![0].length, 17);
            assert.match(short, /Trimmed to 17/);
            assert.doesNotMatch(await fetchText("/long", { max_chars: 13000 }), /Trimmed/);
        });
        await t.test(
            "FlareSolverr fallback for 403/429/503 and challenge HTML, with final URL",
            async () => {
                for (const path of ["/blocked403", "/blocked429", "/blocked503", "/challenge"]) {
                    const output = await fetchText(path);
                    assert.equal(
                        output,
                        `URL: ${base}${path}?solved=1\n\nSolved page\n\nFallback readable content.`,
                    );
                    assert.deepEqual(calls.at(-1)!.body, {
                        cmd: "request.get",
                        url: base + path,
                        maxTimeout: 60000,
                    });
                    assert.equal(calls.at(-1)!.path, "/v1");
                }
                for (const mode of ["fail", "http-fail", "bad-status", "challenge"]) {
                    solverMode = mode;
                    await assert.rejects(
                        fetchText("/blocked403"),
                        /FlareSolverr|browser challenge/,
                    );
                }
                solverMode = "ok";
                const count = calls.filter((call) => call.path === "/v1").length;
                await assert.rejects(fetchText("/missing"), /HTTP 404/);
                await fetchText("/page");
                assert.equal(calls.filter((call) => call.path === "/v1").length, count);
            },
        );
        await t.test(
            "non-http URLs refused before any network request; oversized responses refused",
            async () => {
                const count = calls.length;
                for (const url of [
                    "file:///etc/passwd",
                    "ftp://example.com",
                    "data:text/plain,hello",
                    "javascript:alert(1)",
                ])
                    await assert.rejects(fetchPage.execute({ url }), /Only http\/https/);
                assert.equal(calls.length, count);
                await assert.rejects(fetchText("/large-length"), /5 MB limit/);
                await assert.rejects(fetchText("/large-stream"), /5 MB limit/);
            },
        );
        await t.test(
            "timeouts cover search, page headers/body and solver, without waiting real deadlines",
            async () => {
                const original = AbortSignal.timeout;
                const deadlines: number[] = [];
                AbortSignal.timeout = (ms) => {
                    deadlines.push(ms);
                    return original(50);
                };
                try {
                    await assert.rejects(searchText({ query: "slow" }), /timeout|aborted/i);
                    await assert.rejects(fetchText("/slow"), /timeout|aborted/i);
                    await assert.rejects(fetchText("/slow-body"), /timeout|aborted/i);
                    solverMode = "slow";
                    await assert.rejects(fetchText("/blocked403"), /timeout|aborted/i);
                    assert.deepEqual(deadlines, [20000, 20000, 20000, 20000, 65000]);
                } finally {
                    AbortSignal.timeout = original;
                    solverMode = "ok";
                }
            },
        );
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
