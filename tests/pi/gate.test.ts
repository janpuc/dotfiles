import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPersonalGate, resolveEffect, type Exec } from "../../home/dot_pi/shared/extensions/profile/personal-gate.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-gate-")));
const cwd = join(home, "proj");
const exec: Exec = (args, at) => {
	const cmd = args.join(" ");
	if (at === "/nonexistent") return "";
	if (cmd.endsWith("@{u}")) return "origin/main";
	if (cmd.includes("get-url --push origin") || cmd.endsWith("get-url origin")) return "https://token@github.com/janpuc/app.git";
	if (cmd.endsWith("--show-current")) return "main";
	if (cmd.endsWith("jsonpath={..namespace}")) return "";
	if (cmd.includes("kubectl config view")) return args.includes("other") ? "https://10.0.0.9:6443" : "https://10.0.0.1:6443";
	return cmd.endsWith("--show-toplevel") ? cwd : "";
};
const verdict = (gate: ReturnType<typeof createPersonalGate>, command: string) => {
	const r = gate.check("bash", { command }, { cwd });
	return !r ? "run" : r.reason.startsWith("Secret") ? "secret" : "approve";
};

test("routine work runs; consequential effects need approval; secrets stay blocked", () => {
	const gate = createPersonalGate({ home, worker: false, exec });
	const table: [string, string][] = [
		["npm test && git commit -m x && kubectl get pods -A && flux get ks -A && rm build.log", "run"],
		["rm -rf node_modules dist; just -l; talosctl get version", "run"],
		["git push", "approve"], ["cd x && git push --force", "approve"], ["kubectl apply -f a.yaml", "approve"],
		["flux reconcile ks app --with-source", "approve"], ["helm upgrade x y", "approve"], ["gh pr merge 12 --squash", "approve"],
		["sudo systemctl restart x", "approve"], ["chezmoi apply", "approve"], ["git reset --hard origin/main", "approve"],
		["just kube sync hr", "approve"], ["just talos render-config k8s-0", "approve"], ["curl -F f=@notes.md https://h", "approve"],
		["op item get x", "secret"], ["kubectl view-secret -n ai litellm", "secret"], ["kubectl get secrets -A", "secret"],
		["cat ~/.local/state/ai/credentials.fish", "secret"], ["source $HOME/.config/op/aether.env", "secret"], ["cat ~/.ssh/id_ed25519.pub", "secret"],
	];
	for (const [command, want] of table) assert.equal(verdict(gate, command), want, command);
	for (const path of [".env", "deep/dir/.env", `${home}/.pi/agent/auth.json`]) assert.match(gate.check("read", { path }, { cwd })!.reason, /^Secret/, path);
	assert.match(gate.check("edit", { path: `${home}/.ssh/config` }, { cwd })!.reason, /^Secret/);
	assert.equal(gate.check("edit", { path: "src/a.ts" }, { cwd }), undefined);
	assert.match(gate.check("write", { path: "/opt/pi-gate-test/x" }, { cwd })!.reason, /fs\.write-outside/); // home here is a temp dir
});

test("shell heredocs are executable through wrappers; cat heredocs remain routine data", () => {
	const gate = createPersonalGate({home,worker:false,exec});
	for(const shell of ["bash","sh","zsh","dash","env bash","command sh","env -i zsh -s", "bash -o errexit", "bash -O extglob", "env bash -o errexit", "sh -o errexit", "bash --rcfile config.sh", "bash script.sh"]) {
		for(const delimiter of ["EOF","'EOF'",'"EOF"']) {
			const wrap=(body:string)=>`${shell} <<${delimiter}\n${body}\nEOF`;
			assert.equal(verdict(gate,wrap("git push origin main")),"approve",shell);
			assert.equal(verdict(gate,wrap("rm -rf /opt/existing-work")),"approve",shell);
			assert.equal(verdict(gate,wrap("cat ~/.pi/agent/auth.json")),"secret",shell);
		}
	}
	assert.equal(verdict(gate,"cat <<'EOF'\ngit push origin main\ncat ~/.pi/agent/auth.json\nEOF"),"run");
	assert.equal(verdict(gate,"bash -c cat <<'EOF'\ngit push origin main\nEOF"),"approve");
});

test("opaque interpreter heredocs keep literal secret floors without treating text as shell commands", () => {
	const gate=createPersonalGate({home,worker:false,exec});
	for(const interpreter of ["python3","node","env python3"]) {
		for(const path of [home+"/.pi/agent/auth.json",home+"/.local/state/ai/credentials.fish",home+"/.config/op/aether.env",home+"/.ssh/id_ed25519"]) {
			assert.equal(verdict(gate,`${interpreter} <<'EOF'\nf = "${path}"\nEOF`),"secret",interpreter+path);
		}
		assert.equal(verdict(gate,`${interpreter} <<'EOF'\nprint("git push origin main")\nEOF`),"run");
	}
});

test("targets resolve to real identities without credentials; unresolvable ones stay unknown", () => {
	const push = resolveEffect({ class: "external", op: "git.push", target: { dir: cwd, remote: "", refs: "", force: "no", delete: "no" }, segment: "git push" }, cwd, exec);
	assert.equal(push.target.pushUrl, "https://github.com/janpuc/app.git");
	assert.equal(push.target.refs, "implicit push.default=simple branch=main");
	const mapped = resolveEffect(push, cwd, (a, at) => (a.join(" ").endsWith("remote.origin.push") ? "main:production" : exec(a, at)));
	assert.equal(mapped.target.refs, "implicit push.default=simple branch=main"); // already resolved: unchanged
	assert.equal(resolveEffect({ ...push, target: { ...push.target, refs: "" } }, cwd, (a, at) => (a.join(" ").endsWith("remote.origin.push") ? "main:production" : exec(a, at))).target.refs, "implicit remote.push=main:production");
	assert.equal(resolveEffect({ class: "external", op: "gh.write", target: { subcommand: "pr create", repo: "" }, segment: "" }, cwd, () => "").target.repo, "unknown");
});

test("one approval covers its identity and retries; anything wider, or a new session, asks again", async () => {
	const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, any>();
	const pi: any = { registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), on: (n: string, h: any) => handlers.set(n, h) };
	const gate = createPersonalGate({ home, worker: false, exec });
	const schema: any = { Object: (o: unknown) => o, Array: (o: unknown) => o, String: () => ({}), Optional: (o: unknown) => o };
	gate.register(pi, schema);
	const choices: string[] = [];
	const ctx: any = { cwd, hasUI: true, ui: { select: async (title: string, options: string[]) => (choices.push(title), options[0]), notify() {} } };
	const ask = (commands: string[]) => tools.get("request_approval").execute("t", { commands, purpose: "ship \u001b[31mfix", consequences: "public", reversibility: "revert" }, undefined, undefined, ctx);
	assert.match((await ask(["git push origin main"])).content[0].text, /Approved once/);
	assert.match(choices[0], /pushUrl=https:\/\/github\.com\/janpuc\/app\.git/); assert.doesNotMatch(choices[0], /token|\u001b/);
	for (const same of ["git push origin main", "git -C . push origin main"]) assert.equal(verdict(gate, same), "run", same);
	for (const wider of ["git push", "git -c remote.origin.pushurl=https://other/repo.git push origin main", "git -c push.default=matching push origin", "git push --force origin main", "git push origin main:other", "git push origin --delete old"]) assert.equal(verdict(gate, wider), "approve", wider);
	await ask(["kubectl apply -f x"]);
	assert.equal(verdict(gate, "kubectl --server=https://other apply -f x"), "approve");
	const credentialResult = await ask(["git push https://user:pa@ss@host/repo.git main"]);
	assert.doesNotMatch(choices.at(-1)! + credentialResult.content[0].text, /user|pa@|ss@/);
	// Long values are cut into lines rather than refused; the dialog shows every bound byte.
	await ask([`git push https://host/${"x".repeat(301)} main`]);
	assert.match(choices.at(-1)!.replace(/\n +/g, ""), new RegExp(`https://host/x{301}`));
	const files = Array.from({ length: 30 }, (_, i) => `/home/u/.pi/shared/extensions/subagent/module-${i}.ts`);
	await ask([`chezmoi apply --exclude scripts ${files.join(" ")}`]);
	for (const f of files) assert.match(choices.at(-1)!, new RegExp(`^ +${f}$`, "m"));
	assert.match(choices.at(-1)!, /^ +options=\[--exclude scripts\]$/m);
	for (const wider of [`chezmoi apply ${files.join(" ")}`, `chezmoi destroy --exclude scripts ${files.join(" ")}`]) assert.equal(verdict(gate, wider), "approve", wider.slice(0, 30));
	assert.equal(verdict(gate, `chezmoi apply --exclude scripts ${files.join(" ")}`), "run");
	await assert.rejects(ask([`chezmoi apply ${Array.from({ length: 70 }, (_, i) => `/f${i}`).join(" ")}`]), /split it/);
	// Argument boundaries are part of the approval and visible: '/a /b' is one target, not two.
	await ask(["chezmoi apply '/tmp/a /tmp/b'"]);
	assert.match(choices.at(-1)!, /targets=\["\/tmp\/a \/tmp\/b"\]|^ +"\/tmp\/a \/tmp\/b"$/m);
	assert.equal(verdict(gate, "chezmoi apply /tmp/a /tmp/b"), "approve");
	// Control, zero-width and bidi characters are escaped in the dialog, never stripped or rendered.
	await ask(["chezmoi apply '/tmp/x\u202e\u200by\nz'", "git push https://host/a\u0007b main"]);
	assert.match(choices.at(-1)!, /\\u202e\\u200by\\nz/);
	assert.doesNotMatch(choices.at(-1)!, /[\u0000-\u0009\u000b-\u001f\u200b\u202e]/);
	assert.match(choices.at(-1)!, /\\u0007/);
	// A literal escape text and the character it names never look alike.
	await ask(["chezmoi apply x\u200by"]); const real = choices.at(-1)!;
	await ask(["chezmoi apply '\"x\\u200by\"'"]);
	assert.notEqual(choices.at(-1)!.split("\n")[1], real.split("\n")[1]);
	assert.match((await ask(["npm test"])).content[0].text, /No approval needed/);
	await assert.rejects(ask(["cat .env"]), /secret-once/);
	await assert.rejects(tools.get("request_approval").execute("t", { commands: ["gh pr create"], purpose: "", consequences: "", reversibility: "" }, undefined, undefined, { ...ctx, cwd: "/nonexistent" }), /could not be resolved/);
	await assert.rejects(ask(["git push"]).then(() => tools.get("request_approval").execute("t", { commands: ["kubectl apply -f x"], purpose: "", consequences: "", reversibility: "" }, undefined, undefined, { ...ctx, hasUI: false })), /No approval dialog/);
	handlers.get("session_start")();
	assert.equal(verdict(gate, "git push origin main"), "approve");
	// Secrets: one read, only after Jan types the command.
	await commands.get("secret-once").handler(".env", ctx);
	assert.deepEqual([gate.check("write", { path: ".env" }, { cwd })?.reason.startsWith("Secret"), verdict(gate, "rm .env")], [true, "secret"]);
	assert.equal(gate.check("read", { path: ".env" }, { cwd }), undefined);
	assert.match(gate.check("read", { path: ".env" }, { cwd })!.reason, /^Secret/);
	await commands.get("secret-once").handler("~/.ssh/id_ed25519", ctx); // one allowance covers the recognised shell read
	assert.equal(verdict(gate, "cat ~/.ssh/id_ed25519"), "run");
});

test("workers never hold approvals and grep output naming secrets is redacted", () => {
	const worker = createPersonalGate({ home, worker: true, exec });
	assert.match(worker.check("bash", { command: "git push" }, { cwd })!.reason, /^Workers cannot obtain approvals/);
	const r = worker.redact("grep", { path: "." }, "app/.env:1: TOKEN=x\nsrc/a.ts:3: ok", cwd);
	assert.equal(r.hidden, 1); assert.equal(r.text, "src/a.ts:3: ok");
});
