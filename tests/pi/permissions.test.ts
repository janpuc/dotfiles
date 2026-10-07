// Unit tests for home/dot_pi/shared/extensions/profile/permissions.ts (the Work mirror of the
// organisation's Claude Code permission policy). The policy below is synthetic but has the same
// shape and rule styles as a real server-managed one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { bashScope, commandSegments, decide, parseOrgPolicy, parsePersonalPolicy, redactSearchOutput, type Approvals } from "../../home/dot_pi/shared/extensions/profile/permissions.ts";

const policy = parseOrgPolicy({
	permissions: {
		defaultMode: "default",
		disableBypassPermissionsMode: "disable",
		allow: ["Bash(git status *)", "Bash(git diff *)", "Bash(git push origin *)", "Bash(gh pr *)", "Bash(swift *)"],
		deny: [
			"WebSearch",
			"Bash(git push --force *)",
			"Bash(ssh *)",
			"Bash(scp *)",
			"Bash(wget *)",
			"Bash(perl -e *)",
			"Read(./.env)",
			"Read(./.env.*)",
			"Read(./secrets/**)",
			"Read(**/.aws/credentials)",
			"Read(**/*.pem)",
			"Read(**/.ssh/**)",
			"Read(../**/.netrc)",
		],
		ask: ["Bash(git rebase *)"],
	},
});
const cwd = "/work/repo";
const home = "/Users/me";
const none = (): Approvals => ({ bash: [], tools: [] });
const verdict = (tool: string, input: Record<string, unknown>, approvals = none()) => decide(policy, tool, input, { cwd, home, approvals }).verdict;
const bash = (command: string, approvals = none()) => verdict("bash", { command }, approvals);

test("the policy parser needs a permissions block", () => {
	assert.throws(() => parseOrgPolicy({}), /no permissions block/);
	assert.equal(parseOrgPolicy({ permissions: {}, allowManagedPermissionRulesOnly: true }).managedRulesOnly, true);
});

test("allowed commands run, with or without arguments", () => {
	assert.equal(bash("git status"), "allow");
	assert.equal(bash("git status -s"), "allow");
	assert.equal(bash("git diff HEAD~1 -- src"), "allow");
	assert.equal(bash("git push origin main"), "allow");
	assert.equal(bash("swift build 2>&1"), "allow");
});

test("anything else asks, like Claude Code's default mode", () => {
	assert.equal(bash("npm test"), "ask");
	assert.equal(bash("git rebase -i HEAD~3"), "ask");
	assert.equal(bash("git statusx"), "ask");
});

test("deny rules win, also inside compound commands and substitutions", () => {
	assert.equal(bash("git push --force origin main"), "deny");
	assert.equal(bash("git status && ssh prod"), "deny");
	assert.equal(bash("echo $(scp a b:)"), "deny");
	assert.equal(bash("echo `wget http://x`"), "deny");
	assert.equal(bash("FOO=1 ssh host"), "deny");
	assert.equal(bash("git status | perl -e 'print 1'"), "deny");
	assert.equal(bash("git status; ssh x", { bash: ["ssh"], tools: ["bash"] }), "deny", "approvals never override deny");
});

test("every segment of a compound command must be covered", () => {
	assert.equal(bash("git status && git diff"), "allow");
	assert.equal(bash("git status && npm test"), "ask");
	assert.ok(!commandSegments("git status 2>&1").includes("1"), "2>&1 is a redirection, not a separator");
});

test("session approvals cover a command scope or a tool", () => {
	assert.equal(bash("npm test -- --watch", { bash: ["npm test"], tools: [] }), "allow");
	assert.equal(bash("npm install", { bash: ["npm test"], tools: [] }), "ask");
	assert.equal(bashScope("npm test -- --watch"), "npm test");
	assert.equal(bashScope("ls -la"), "ls");
	assert.equal(bashScope("FOO=1 make build"), "make build");
});

test("read-only tools run unless a Read rule denies the path", () => {
	assert.equal(verdict("read", { path: "src/main.swift" }), "allow");
	assert.equal(verdict("ls", {}), "allow");
	assert.equal(verdict("read", { path: ".env" }), "deny");
	assert.equal(verdict("read", { path: "./.env.local" }), "deny");
	assert.equal(verdict("read", { path: "secrets/prod/key.json" }), "deny");
	assert.equal(verdict("grep", { pattern: "x", path: "secrets" }), "deny");
	assert.equal(verdict("read", { path: "~/.aws/credentials" }), "deny");
	assert.equal(verdict("read", { path: "/elsewhere/cert.pem" }), "deny");
	assert.equal(verdict("find", { path: "~/.ssh" }), "deny");
	assert.equal(verdict("read", { path: "../other/.netrc" }), "deny");
	assert.equal(verdict("read", { path: "docs/.env.md" }), "allow", "./.env.* only covers the project root");
});

test("edits ask unless approved for the session; denied paths stay denied", () => {
	assert.equal(verdict("edit", { path: "src/a.swift" }), "ask");
	assert.equal(verdict("write", { path: "src/a.swift" }, { bash: [], tools: ["edit", "write"] }), "allow");
	assert.equal(verdict("write", { path: ".env" }, { bash: [], tools: ["edit", "write"] }), "allow", "Read rules do not cover writes, as in Claude Code");
});

test("memory and delegation tools need no approval; unknown tools ask; named deny rules apply", () => {
	assert.equal(verdict("memory_recall", { query: "x" }), "allow");
	assert.equal(verdict("subagent", {}), "allow");
	assert.equal(verdict("advisor", {}), "allow");
	assert.equal(verdict("some_extension_tool", {}), "ask");
	assert.equal(verdict("websearch", {}), "deny");
});

test("search output naming denied files is redacted", () => {
	const grep = redactSearchOutput(policy, "grep", { pattern: "password", path: "." }, ["src/a.ts:3: password = input", ".env:1: PASSWORD=hunter2", "secrets/db.json-4- x", "notes.md:9: password policy"].join("\n"), cwd, home);
	assert.equal(grep.hidden, 2);
	assert.equal(grep.text, "src/a.ts:3: password = input\nnotes.md:9: password policy");
	const ls = redactSearchOutput(policy, "ls", { path: "~" }, [".aws/", ".ssh/", "Documents/"].join("\n"), cwd, home);
	assert.equal(ls.text, ".aws/\nDocuments/", "~/.ssh is hidden; ~/.aws is fine, only .aws/credentials is denied");
	const find = redactSearchOutput(policy, "find", { pattern: "*.pem", path: "/etc" }, "ssl/cert.pem\nssl/readme", cwd, home);
	assert.equal(find.text, "ssl/readme");
	assert.equal(redactSearchOutput(policy, "read", {}, ".env:1: x", cwd, home).hidden, 0);
});

// --- Personal policy (the real ~/.pi/shared/personal-policy.json) --------------------------------

const personal = parsePersonalPolicy(JSON.parse(readFileSync(new URL("../../home/dot_pi/shared/personal-policy.json", import.meta.url), "utf8")));
const H = "/home/u";
const p = (tool: string, input: Record<string, unknown>, cwd = `${H}/Development/janpuc/app`, approvals: Approvals = { bash: [], tools: [] }) =>
	decide(personal, tool, input, { cwd, home: H, approvals }).verdict;

test("personal: anything no rule covers runs", () => {
	for (const command of ["npm test", "git status", "git commit -m x", "kubectl get pods -A", "flux get ks -A", "rm build.log", "talosctl get version"])
		assert.equal(p("bash", { command }), "allow", command);
	assert.equal(p("edit", { path: "src/a.ts" }), "allow");
	assert.equal(p("write", { path: `${H}/Development/janpuc/app/new.ts` }), "allow");
	assert.equal(p("some_extension_tool", {}), "allow");
	assert.equal(p("read", { path: "README.md" }), "allow");
});

test("personal: publishing, cluster changes, sudo and forced deletes ask", () => {
	for (const command of [
		"git push",
		"git push origin main",
		"cd x && git push --force",
		"kubectl apply -f a.yaml",
		"kubectl -n ai delete pod x".replace("-n ai ", ""),
		"flux reconcile ks app --with-source",
		"talosctl upgrade --image x",
		"helm upgrade x y",
		"gh pr merge 12 --squash",
		"sudo systemctl restart x",
		"chezmoi apply",
		"rm -rf node_modules",
		"git reset --hard origin/main",
		"op item get x",
	])
		assert.equal(p("bash", { command }), "ask", command);
	assert.equal(p("edit", { path: `${H}/Development/janpuc/home-ops/kubernetes/a.yaml` }), "ask", "home-ops is read-only unless asked");
});

test("personal: credential stores are never read, by tools or by shell", () => {
	for (const path of [`${H}/.local/state/ai/credentials.fish`, `${H}/.config/op/aether.env`, `${H}/.ssh/id_ed25519`, `${H}/.pi/agent/auth.json`, `${H}/.config/gh/hosts.yml`, ".env", "deep/dir/.env"])
		assert.equal(p("read", { path }), "deny", path);
	for (const command of ["cat ~/.local/state/ai/credentials.fish", "source $HOME/.config/op/aether.env", "cat ~/.ssh/id_ed25519"])
		assert.equal(p("bash", { command }), "deny", command);
	assert.equal(p("read", { path: `${H}/.ssh/id_ed25519.pub` }), "deny", "a .pub is under the same id_* rule; reading it is not needed");
	assert.equal(p("edit", { path: `${H}/.ssh/config` }), "deny");
});

test("personal: session approvals cover an asked scope", () => {
	assert.equal(p("bash", { command: "git push origin main" }, undefined, { bash: ["git push"], tools: [] }), "allow");
	assert.equal(p("bash", { command: "kubectl apply -f a.yaml" }, undefined, { bash: ["git push"], tools: [] }), "ask");
	assert.equal(p("edit", { path: `${H}/Development/janpuc/home-ops/a.yaml` }, undefined, { bash: [], tools: ["edit"] }), "allow");
	// Work keeps Claude Code's semantics: an ask rule asks even after a session approval.
	assert.equal(decide(policy, "bash", { command: "git rebase main" }, { cwd: "/w", home: "/h", approvals: { bash: ["git rebase"], tools: [] } }).verdict, "ask");
});

test("personal: search output naming credential files is redacted", () => {
	const r = redactSearchOutput(personal, "grep", { path: "." }, "app/.env:1: TOKEN=x\nsrc/a.ts:3: ok", `${H}/Development/janpuc`, H);
	assert.equal(r.hidden, 1);
	assert.match(r.text, /src\/a.ts/);
});
