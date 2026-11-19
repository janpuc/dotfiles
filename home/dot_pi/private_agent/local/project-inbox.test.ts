import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerOpen, type InboxItem } from "./project-inbox.ts";

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
	fs.mkdirSync(join(home, ".pi/agent"), { recursive: true });
	fs.writeFileSync(join(home, ".pi/agent/usage.json"), JSON.stringify({
		claude: { windows: [{ name: "5h", usedPct: 20 }, { name: "week", usedPct: 40 }] },
	}));
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

function harness(mode: string, hasUI: boolean, choose: () => Promise<string | undefined>) {
	const sent: string[] = [];
	let asked = 0;
	const pi = { sendUserMessage: (text: string) => { sent.push(text); } };
	const ctx: any = {
		mode,
		hasUI,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			select: async (...args: any[]) => { asked++; return choose(); },
			notify: () => {},
		},
	};
	const state = { offered: new Set<string>(), busy: false, promptOpen: false };
	return { pi, ctx, state, sent, asked: () => asked };
}

test("two accepted items both arrive, the streaming second as a followUp", async () => {
	const f = fixture();
	try {
		const second = { ...f.item, id: "20261118T120001-abcdef", text: "Second request" };
		fs.writeFileSync(join(f.workspace, ".agent/inbox", `${second.id}.json`), JSON.stringify(second));
		const h = harness("tui", true, async () => "Take this on now");
		let idle = true;
		h.ctx.isIdle = () => idle;
		const delivered: { text: string; options: unknown }[] = [];
		const pi = { sendUserMessage: (text: string, options?: unknown) => {
			delivered.push({ text, options });
			idle = false;
		} };
		await offerOpen(pi as any, "home", f.workspace, h.ctx, h.state);
		assert.equal(delivered.length, 2);
		assert.match(delivered[0].text, /Rotate the speaker/);
		assert.equal(delivered[0].options, undefined);
		assert.match(delivered[1].text, /Second request/);
		assert.deepEqual(delivered[1].options, { deliverAs: "followUp" });
		assert.equal(f.status(), "accepted");
		assert.equal(JSON.parse(fs.readFileSync(join(f.workspace, ".agent/inbox", `${second.id}.json`), "utf8")).status, "accepted");
	} finally {
		f.restore();
	}
});

test("an inbox item reaches the agent only after Take this on now", async () => {
	const f = fixture();
	try {
		for (const [mode, hasUI] of [["print", false], ["rpc", true]] as const) {
			const h = harness(mode, hasUI, async () => "Take this on now");
			await offerOpen(h.pi as any, "home", f.workspace, h.ctx, h.state);
			assert.equal(h.sent.length, 0, `${mode} mode must not send`);
			assert.equal(h.asked(), 0, `${mode} mode must not prompt`);
			assert.equal(f.status(), "new");
		}
		for (const choice of [undefined, "Later"]) {
			const h = harness("tui", true, async () => choice);
			await offerOpen(h.pi as any, "home", f.workspace, h.ctx, h.state);
			assert.equal(h.sent.length, 0, `${choice ?? "cancel"} must not send`);
			assert.equal(f.status(), "new");
		}
		const h = harness("tui", true, async () => "Take this on now");
		await offerOpen(h.pi as any, "home", f.workspace, h.ctx, h.state);
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0], /Request 20261118T120000-abcdef from kubernetes/);
		assert.match(h.sent[0], /Rotate the speaker node token\./);
		assert.match(h.sent[0], /agent reply home 20261118T120000-abcdef/);
		assert.equal(f.status(), "accepted");
	} finally {
		f.restore();
	}
});