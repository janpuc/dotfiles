import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import guard, { hardDeny } from "./agent-guard.ts";

// Each hard-deny item is refused.
for (const [command, profile = "personal", cwd = "/tmp"] of [
	["git push -f origin main"], ["git push --force origin master"], ["git -C /x push origin +main"],
	["git push --force-with-lease origin HEAD"], ["git push -f"], ["git push origin :main"],
	["git push --delete origin main"], ["git push --mirror origin"],
	["zfs destroy Vault/Backups/sisyphus"], ["ssh bigmouth 'sudo zfs destroy -r Vault/x@snap'"],
	["midclt call pool.dataset.delete Vault/x"],
	["curl -X DELETE https://nas/api/v2.0/pool/dataset/id/Vault%2Fx"],
	["talosctl reset -n 10.0.0.1"], ["talosctl upgrade-k8s --to 1.36.0"], ["talosctl wipe disk sda"],
	["kubectl delete namespace media"], ["kubectl delete ns/media"], ["kubectl -n db delete pvc data-0"],
	["kubectl delete pv,pod x"],
	["terraform destroy"], ["tofu apply -destroy"], ["terraform apply", "work", "/Users/j/Work/infra/prod/eks"],
	["AWS_PROFILE=wbd-prod terraform apply", "work"],
	["gh repo delete janpuc/x --yes"],
	["curl -X PUT https://matrix.example/_matrix/client/v3/rooms/!a/send/m.room.message/1 -d '{}'"],
	["curl https://slack.com/api/chat.postMessage -d text=hi"], ["sendmail jan@example.com < msg"],
	["osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"x\"'"],
	["bash -c 'kubectl delete ns media'"], ["eval kubectl delete ns media"],
	["export AGENT_OVERRIDE=yes; kubectl delete ns media"],
	["git push --repo=origin +main"], ["git push --repo origin :main"], ["kubectl delete pod/x pvc/y"],
	["bash -ce 'kubectl delete ns media'"], ["terraform -chdir /x/prod apply", "work"],
	["AGENT_OVERRIDE=x bash -c 'kubectl delete ns a; kubectl delete ns b'"],
	["talosctl reset --dry-run=false"], ["if true; then kubectl delete ns media; fi"],
	["cd /x/prod && terraform apply", "work", "/tmp"],
] as [string, string?, string?][]) test(`refused: ${command}`, () => assert.ok(hardDeny(command, profile, cwd).denied));

// Normal work runs without a question.
for (const command of [
	"git push", "git push origin feature", "git push -f origin feature", "git push origin +feature",
	"git push --force-with-lease origin task/x:task/x", "gh pr create --fill", "gh pr merge 12 --squash",
	"kubectl apply -f x.yaml", "kubectl delete pod x", "kubectl rollout restart deploy/x", "kubectl delete ns x --dry-run=client",
	"flux reconcile ks apps", "helm upgrade x y", "chezmoi apply", "terraform apply", "terraform plan",
	"talosctl upgrade-k8s --to 1.36.0 --dry-run", "grep pool.dataset.delete plan.md", "zfs list -t snapshot",
	"curl https://hass.janpuc.com/api/services/light/turn_on -d '{}'",
	"curl -s https://mastodon.social/api/v1/statuses/123", "curl -s https://discord.com/api/v10/channels/1/messages",
]) test(`allowed: ${command}`, () => assert.equal(hardDeny(command, "personal", "/tmp").denied, undefined));

test("terraform apply is only refused on production at work", () => {
	assert.equal(hardDeny("terraform apply", "personal", "/x/prod").denied, undefined);
	assert.equal(hardDeny("terraform apply", "work", "/Users/j/Work/infra/dev").denied, undefined);
});

function run(env: Record<string, string>, command: string) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const saved = { ...process.env };
	Object.assign(process.env, env);
	try {
		guard({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { handlers[name] = fn; } } as never);
		const result = handlers.tool_call({ toolName: "bash", input: { command } }, { cwd: "/tmp" }) as { block?: boolean } | undefined;
		if (!result?.block) handlers.tool_result({ toolName: "bash", input: { command }, isError: false }, {});
		return result;
	} finally {
		for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
	}
}

const records = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

test("an override lifts one command once and is logged", () => {
	const log = join(mkdtempSync(join(tmpdir(), "guard-")), "actions.jsonl");
	const env = { AGENT_ACTION_LOG: log, PI_SUBAGENT_CHILD: "", PI_SUBAGENTS_HERDR_BRIDGE: "" };
	assert.equal(run(env, 'AGENT_OVERRIDE="Jan: drop the old media ns" kubectl delete ns media'), undefined);
	assert.ok(run(env, "kubectl delete ns media")?.block, "the next command is refused again");
	assert.ok(run(env, 'AGENT_OVERRIDE=x true; kubectl delete ns media')?.block, "an override covers only its own command");
	const kinds = records(log).map((r) => `${r.kind}:${r.what}`);
	assert.deepEqual(kinds, [
		"override:deleting a Kubernetes namespace", "action:a cluster change",
		"denied:deleting a Kubernetes namespace", "denied:deleting a Kubernetes namespace",
	]);
	assert.equal(records(log)[0].reason, "Jan: drop the old media ns");
});

test("children keep the deny list and cannot override", () => {
	const log = join(mkdtempSync(join(tmpdir(), "guard-")), "actions.jsonl");
	const result = run({ AGENT_ACTION_LOG: log, PI_SUBAGENT_CHILD: "1" }, 'AGENT_OVERRIDE=x git push -f origin main');
	assert.ok(result?.block);
	assert.equal(records(log)[0].kind, "denied");
});
