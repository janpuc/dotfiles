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

test("new items reach the agent without a prompt, the second as a followUp, once", () => {
	const f = fixture();
	try {
		const second = { ...f.item, id: "20261118T120001-abcdef", text: "Second request" };
		fs.writeFileSync(join(f.workspace, ".agent/inbox", `${second.id}.json`), JSON.stringify(second));
		let idle = true;
		const ctx: any = { isIdle: () => idle, ui: { notify: () => {} } };
		const delivered: { text: string; options: unknown }[] = [];
		const pi = { sendUserMessage: (text: string, options?: unknown) => { delivered.push({ text, options }); idle = false; } };
		const state = { delivered: new Set<string>(), promptOpen: false };
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		deliverOpen(pi as any, "home", f.workspace, ctx, state);
		assert.equal(delivered.length, 2);
		assert.match(delivered[0].text, /Request 20261118T120000-abcdef from kubernetes/);
		assert.match(delivered[0].text, /agent reply home 20261118T120000-abcdef/);
		assert.equal(delivered[0].options, undefined);
		assert.deepEqual(delivered[1].options, { deliverAs: "followUp" });
		assert.equal(f.status(), "accepted");
	} finally {
		f.restore();
	}
});
