import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import projectContext from "./project-context.ts";

const BUDGET = 24576;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// A temporary HOME with a registry, a standards manifest and one project workspace.
function fixture(state: string) {
	const home = fs.mkdtempSync(join(tmpdir(), "project-context-test-"));
	const standards = join(home, ".config/agents/standards");
	fs.mkdirSync(standards, { recursive: true });
	const files = { "session.md": "# Session\nLoad the standards.\n", "handoff.md": "# Handoff\nCommit locally.\n" };
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(join(standards, name), text);
	fs.writeFileSync(join(standards, "manifest.json"), JSON.stringify({
		schemaVersion: 1,
		version: "2.0.0",
		compatibility: { contextSchemaVersion: 1, bootstrapMaxBytes: BUDGET },
		files: Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text) })),
	}));
	fs.writeFileSync(join(home, ".config/agents/projects.json"), JSON.stringify({ projects: { home: {} } }));
	const workspace = join(home, "Development/home");
	fs.mkdirSync(join(workspace, "notes"), { recursive: true });
	fs.writeFileSync(join(workspace, "notes/PROJECT.md"), "# Home\n\n## Facts\n\nOne cluster.\n");
	fs.writeFileSync(join(workspace, "notes/STATE.md"), state);
	const keys = ["HOME", "PI_PROJECT", "PI_PROJECT_DIR", "PI_PROJECT_ROOT"];
	const saved = keys.map((key) => process.env[key]);
	process.env.HOME = home;
	process.env.PI_PROJECT = "home";
	process.env.PI_PROJECT_DIR = workspace;
	process.env.PI_PROJECT_ROOT = join(home, "Development");
	return {
		workspace,
		restore() {
			keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

function harness() {
	const handlers: Record<string, any> = {};
	projectContext({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
	const notices: string[] = [];
	const ctx: any = { hasUI: false, ui: { notify: (message: string) => notices.push(message) } };
	return { handlers, notices, inject: () => handlers.before_agent_start({}, ctx) };
}

test("context is injected again after compaction and after a changed STATE hash", () => {
	const f = fixture("# State\n\n## Current work\n\nnone.\n");
	try {
		const h = harness();
		const first = h.inject();
		assert.ok(first);
		assert.match(first.message.content, /## Standard: session\.md/);
		assert.match(first.message.content, /## notes\/STATE\.md/);
		assert.match(first.message.content, /- Standards: injected below from ~\/\.config\/agents\/standards\/\. Project notes: .+\/notes\/\. Do not search for these files\./);
		assert.equal(h.inject(), undefined);
		h.handlers.session_compact({}, {});
		const afterCompaction = h.inject();
		assert.ok(afterCompaction);
		assert.match(afterCompaction.message.content, /none\./);
		assert.equal(h.inject(), undefined);
		fs.writeFileSync(join(f.workspace, "notes/STATE.md"), "# State\n\n## Current work\n\nrewritten.\n");
		const afterChange = h.inject();
		assert.ok(afterChange);
		assert.match(afterChange.message.content, /rewritten\./);
		assert.equal(h.inject(), undefined);
		const record = JSON.parse(fs.readFileSync(join(f.workspace, ".agent/context.json"), "utf8"));
		assert.equal(record.files["notes/STATE.md"].sha256, sha("# State\n\n## Current work\n\nrewritten.\n"));
	} finally {
		f.restore();
	}
});

test("an oversized context is reported and never truncated", () => {
	const f = fixture(`# State\n\n## Current work\n\n${"x".repeat(BUDGET)}\n\nEND-OF-STATE\n`);
	try {
		const h = harness();
		const injected = h.inject();
		assert.ok(injected);
		assert.match(injected.message.content, new RegExp(`over the ${BUDGET} byte budget`));
		assert.match(injected.message.content, /Nothing is truncated/);
		assert.ok(injected.message.content.includes("END-OF-STATE"));
		assert.ok(h.notices.some((notice) => notice.includes(`over the ${BUDGET} byte budget`)));
	} finally {
		f.restore();
	}
});