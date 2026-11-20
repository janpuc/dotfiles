import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverOpen, type InboxItem } from "./project-inbox.ts";

// A temporary HOME with one project workspace and one new inbox item.
function fixture() {
	const home = fs.mkdtempSync(join(tmpdir(), "project-inbox-test-"));
	const workspace = join(home, "Development/home");
	const inbox = join(workspace, ".agent/inbox");
	fs.mkdirSync(inbox, { recursive: true });
	const item: InboxItem = {
		id: "20261118T120000-abcdef",
		from: "kubernetes",
		to: "home",
		text: "Rotate the speaker node token.",
		created: "2026-11-18T12:00:00Z",
		status: "new",
	};
	fs.writeFileSync(join(inbox, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
	const saved = process.env.HOME;
	process.env.HOME = home;
	return {
		workspace,
		item,
		status: () => JSON.parse(fs.readFileSync(join(inbox, `${item.id}.json`), "utf8")).status,
		restore() {
			if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

test("new items reach an idle agent one at a time without a prompt, once", () => {
	const f = fixture();
	try {
		const second = { ...f.item, id: "20261118T120001-abcdef", text: "Second request" };
		fs.writeFileSync(join(f.workspace, ".agent/inbox", `${second.id}.json`), JSON.stringify(second));
		let idle = true;
		const ctx: any = { isIdle: () => idle, hasPendingMessages: () => false, ui: { notify: () => {} } };
		const delivered: { text: string; options: unknown }[] = [];
		const pi = { sendUserMessage: (text: string, options?: unknown) => { delivered.push({ text, options }); idle = false; } };
		const state = { delivered: new Set<string>(), promptOpen: false };
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		assert.equal(delivered.length, 1, "nothing is handed over while the agent runs");
		idle = true;
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		idle = true;
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		assert.equal(delivered.length, 2);
		assert.match(delivered[0].text, /Request 20261118T120000-abcdef from kubernetes/);
		assert.match(delivered[0].text, /agent reply home 20261118T120000-abcdef/);
		assert.equal(delivered[0].options, undefined);
		assert.match(delivered[1].text, /Second request/);
		assert.equal(f.status(), "accepted");
	} finally {
		f.restore();
	}
});

test("a task report reaches the coordinator as a report, not a request to answer", () => {
	const f = fixture();
	try {
		const report = { ...f.item, id: "20261120T120000-abcdef", from: "home", kind: "report", task: "speakers", text: "Done, 3 tests pass." };
		fs.rmSync(join(f.workspace, ".agent/inbox", `${f.item.id}.json`));
		fs.writeFileSync(join(f.workspace, ".agent/inbox", `${report.id}.json`), JSON.stringify(report));
		const ctx: any = { isIdle: () => true, hasPendingMessages: () => false, ui: { notify: () => {} } };
		const delivered: string[] = [];
		deliverOpen({ sendUserMessage: (text: string) => { delivered.push(text); } } as any, "home", f.workspace, ctx, { delivered: new Set(), promptOpen: false });
		assert.equal(delivered.length, 1);
		assert.match(delivered[0], /Report 20261120T120000-abcdef from task speakers/);
		assert.match(delivered[0], /Done, 3 tests pass\./);
		assert.match(delivered[0], /agent task send home speakers/);
		assert.doesNotMatch(delivered[0], /agent reply/);
	} finally {
		f.restore();
	}
});
