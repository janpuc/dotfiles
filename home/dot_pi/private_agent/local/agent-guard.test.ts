import assert from "node:assert/strict";
import { test } from "node:test";
import guard, { sharedChange } from "./agent-guard.ts";
import ask from "./agent-guard-ask.ts";
import child from "./agent-guard-child.ts";

for (const command of [
	...['delete', 'terminate', 'modify', 'put', 'create', 'update', 'attach', 'detach', 'stop', 'reboot']
		.map((verb) => `aws --profile dev ec2 ${verb}-example --dry-run`),
	"aws iam add-user-to-group", "aws iam generate-credential-report", "aws s3 rm s3://bucket/a", "aws s3 mv a b",
	"aws --cli-binary-format raw-in-base64-out s3 cp --exclude '*' a s3://bucket/a", "aws s3 sync . s3://bucket", "aws s3api put-object", "aws s3api delete-object",
	"aws --cli-input-json file://x ec2 terminate-instances", "aws ec2 run-instances --cli-input-json file://x",
	"aws ec2 start-instances", "aws ec2 authorize-security-group-ingress --group-id sg-test",
	"aws --profile dev --region eu-west-1 --output json --cli-input-json file://x --debug ec2 start-instances",
	"aws s3 cp s3://bucket/a ./a", "aws ec2 future-write-verb", "tofu apply", "tofu state rm x",
	"terraform apply", "terraform destroy", "terraform import x y", "terraform taint x",
	"terraform state rm x", "terraform state mv x y", "assume WBD/prod/Admin", "granted assume prod-readonly",
	"bash -c 'aws ec2 stop-instances'", "git push",
]) test(`work guard: ${command}`, () => assert.ok(sharedChange(command, "work")));

for (const command of ["aws s3 ls", "aws ec2 describe-instances", "aws sts get-caller-identity", "terraform plan", "tofu plan",
	"aws --profile dev --region eu-west-1 --output json --cli-input-json file://x --debug ec2 describe-instances",
	"aws dynamodb scan", "aws dynamodb query", "aws ec2 wait instance-running", "aws help",
	"aws iam list-users", "assume dev/Admin"])
	test(`work reads: ${command}`, () => assert.equal(sharedChange(command, "work"), undefined));

for (const command of [
	"git push origin main",
	"git -C /tmp/repo push",
	"gh pr merge 123 --squash",
]) test(command, () => assert.ok(sharedChange(command)));

for (const command of [
	"curl -X POST https://hass.janpuc.com/api/services/light/turn_on",
	"curl https://hass.janpuc.com/api/states/light.desk -XPUT",
	"curl --request=PATCH https://hass.janpuc.com/api/config",
	"curl -X DELETE 'https://hass.janpuc.com/api/states/foo'",
	'curl -d \'{"entity_id":"light.desk"}\' "$HA_URL/api/services/light/turn_off"',
	'curl --data-binary=@body "${HA_URL}/api/states/foo"',
	"wget --post-data='{}' https://hass.janpuc.com/api/services/foo",
	"wget --method=DELETE https://hass.janpuc.com/api/states/foo",
	"wget --method='POST' https://hass.janpuc.com/api/services/foo",
	"curl -sSXPOST --url='https://hass.janpuc.com:443/api/services/foo'",
	"curl -fsSLd '{}' https://hass.janpuc.com/api/states/foo",
	"http POST https://hass.janpuc.com/api/services/light/turn_on entity_id=light.desk",
	"http https://hass.janpuc.com/api/states/foo state=on",
	"curl -X POST https://hass.janpuc.com/api/template/other",
	"curl -d '{}' https://hass.janpuc.com/api/template https://hass.janpuc.com/api/services/foo",
	"curl -X POST \\\n  https://hass.janpuc.com/api/services/foo",
]) test(command, () => assert.equal(sharedChange(command), "a Home Assistant write"));

for (const command of [
	"curl https://hass.janpuc.com/api/states",
	"curl -X GET https://hass.janpuc.com/api/states",
	"curl -XGET https://hass.janpuc.com/api/states",
	"curl -sSXGET --url='https://hass.janpuc.com:443/api/states'",
	"curl --request='GET' https://hass.janpuc.com/api/states",
	"wget --method=GET https://hass.janpuc.com/api/states",
	'curl -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states"',
	"wget https://hass.janpuc.com/api/states",
	"http GET https://hass.janpuc.com/api/states",
	"http GET https://hass.janpuc.com/api/states filter==light",
	"http https://hass.janpuc.com/api/states filter==light",
	'curl -d \'{"template":"a | b"}\' "$HA_URL/api/template"',
	"curl -X POST https://hass.janpuc.com/api/template?foo=bar",
	"curl -X POST https://elsewhere.example/api/services/foo",
	"curl -X POST https://hass.janpuc.com.evil.example/api/services/foo",
	"git status",
]) test(command, () => assert.equal(sharedChange(command), undefined));

// Review probe-out.txt and probe2-out.txt, plus wrapper and option-scope regressions.
const regressions: [string, string | undefined][] = [
	["bash -c 'git push'", "git push"],
	["bash -c 'gh pr merge 123'", "a GitHub write"],
	['bash -c \'curl -X POST "$HA_URL/api/services/light/turn_on"\'', "a Home Assistant write"],
	["env FOO=1 git -C /tmp/x push", "git push"],
	["gh api -X POST repos/a/b/issues", "a GitHub write"],
	["gh --repo a/b api -X POST repos/a/b/issues", "a GitHub write"],
	['curl -X POST \\\n  "$HA_URL/api/services/light/turn_on"', "a Home Assistant write"],
	// Without a continuation, the URL is a separate command, not a curl argument.
	['curl -X POST\n"$HA_URL/api/services/light/turn_on"', undefined],
	['curl -G --data foo=bar "$HA_URL/api/states"', undefined],
	["curl -X POST https://hass.janpuc.com/api/template/", undefined],
	['curl -d{} "$HA_URL/api/services/light/turn_on"', "a Home Assistant write"],
	['curl -sS --data \'{}\' "$HA_URL/api/services/light/turn_on"', "a Home Assistant write"],
	["gh api repos/a/b/issues \\\n -X POST -f title=test", "a GitHub write"],
	["git push origin main; kubectl apply --dry-run=client -f demo.yaml", "git push"],
	["printf '%s\\n' --dry-run; git push", "git push"],
	['curl -G --data-urlencode \'filter=light\' "$HA_URL/api/states"', undefined],
	['sh -lc "git push origin main"', "git push"],
	["$(git push)", "git push"],
	["sudo -u x git push", "git push"],
	["eval 'gh pr merge 1'", "a GitHub write"],
	["git push --dry-run", undefined],
	["kubectl apply --dry-run=server -f x && git push", "git push"],
	['curl -s "$HA_URL/api/states/light.x"', undefined],
	['curl -X POST "$HA_URL/api/template?x=1" -d \'{}\'', undefined],
	["wget --post-data='{}' https://hass.janpuc.com/api/services/light/turn_on", "a Home Assistant write"],
	["env FOO=1 bash -ec 'git push'", "git push"],
	["zsh -c 'git push'", "git push"],
	["dash -c 'git push'", "git push"],
	["fish -c 'git push'", "git push"],
	["command exec nohup time git push", "git push"],
	['echo "$(git push)"', "git push"],
	["echo `git push`", "git push"],
	["echo '$(git push)'", undefined],
	["printf 'git push; gh pr merge 1'", undefined],
	["gh -R a/b api repos/a/b/issues --method=PATCH", "a GitHub write"],
	["gh api repos/a/b/issues --field title=test", "a GitHub write"],
	["gh api repos/a/b/issues --raw-field=title=test", "a GitHub write"],
	["gh api repos/a/b/issues --input body.json", "a GitHub write"],
	["gh api repos/a/b/issues -Ftitle=test -X GET", undefined],
	["gh api repos/a/b/issues --input body.json --method HEAD", undefined],
	["gh api graphql -f 'query=query { viewer { login } }'", undefined],
	["gh api graphql -f 'query=mutation { addComment { id } }'", "a GitHub write"],
	["gh api -f 'query=mutation { addComment { id } }' graphql", "a GitHub write"],
	["gh api graphql -f 'query=query { viewer { login } }' -f operationName=mutation", undefined],
	["gh api graphql --raw-field='query=mutation { addComment { id } }'", "a GitHub write"],
	["git push -n", undefined],
	["git push -- --dry-run", "git push"],
	["git push -o --dry-run origin main", "git push"],
	["git push --dry-run && gh pr merge 1", "a GitHub write"],
	["gh pr merge 1 --dry-run", "a GitHub write"],
	["chezmoi apply -n", undefined],
	["chezmoi update --dry-run", "a dotfiles apply"],
	["kubectl apply --dry-run=none -f x", "a cluster change"],
	["kubectl apply --dry-run none -f x", "a cluster change"],
	["kubectl apply --dry-run=server --dry-run=none -f x", "a cluster change"],
	["kubectl apply -f --dry-run", "a cluster change"],
	["helm install x y --dry-run", undefined],
	["flux reconcile source git x --dry-run", undefined],
	["talosctl apply-config --dry-run -f x", undefined],
	["echo ok | git push", "git push"],
	["echo ok || git push", "git push"],
	["echo ok & git push", "git push"],
	["echo ok\ngit push", "git push"],
	['curl -X POST -G --data-urlencode x=y "${HA_URL}/api/states"', "a Home Assistant write"],
	['curl -X GET -d x=y "$HA_URL/api/states"', undefined],
	['curl --get --data-urlencode x=y "$HA_URL/api/states"', undefined],
	['curl -X POST "$HA_URL/api/template/?x=1" -d \'{}\'', undefined],
	['wget --post-file=body.json "$HA_URL/api/services/light/turn_on"', "a Home Assistant write"],
	['https PATCH "$HA_URL/api/states/light.x" state=on', "a Home Assistant write"],
	["bash -c", "an unclassified shell command"],
	['bash -c "$CMD"', "an unclassified shell command"],
	["sh -c 'git push", "an unclassified shell command"],
];

for (const [command, expected] of regressions) test(`shared and adapters: ${command}`, async (t) => {
	const keys = ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"];
	const saved = keys.map((key) => process.env[key]);
	t.after(() => keys.forEach((key, i) => {
		if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
	}));
	for (const key of keys) delete process.env[key];
	assert.equal(sharedChange(command), expected);
	const event = { toolName: "bash", input: { command } };
	let parentHandler: any, childHandler: any;
	ask({ on: (_: string, fn: any) => { parentHandler = fn; } } as any);
	let prompts = 0;
	const context = (approved: boolean) => ({ mode: "tui", hasUI: true,
		ui: { confirm: async () => { prompts++; return approved; } } });
	assert.equal((await parentHandler(event, context(false)))?.block, expected ? true : undefined);
	assert.equal(prompts, expected ? 1 : 0);
	assert.equal(await parentHandler(event, context(true)), undefined);
	assert.equal((await parentHandler(event, { mode: "print", hasUI: false }))?.block, expected ? true : undefined);
	process.env.PI_SUBAGENT_CHILD = "1";
	child({ on: (_: string, fn: any) => { childHandler = fn; } } as any);
	assert.equal(childHandler(event)?.block, expected ? true : undefined);
});

test("child guard blocks the same HA writes without prompting", () => {
	let handler: any;
	guard({ on: (_: string, fn: any) => { handler = fn; } } as any);
	assert.equal(handler({ toolName: "bash", input: { command: "curl -X POST $HA_URL/api/services/light/turn_on" } }).block, true);
	assert.equal(handler({ toolName: "bash", input: { command: "curl $HA_URL/api/states" } }), undefined);
});

test("ask gate requires TUI approval and never registers in children", async (t) => {
	const keys = ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"];
	const saved = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	t.after(() => keys.forEach((key, i) => {
		if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
	}));
	let handler: any;
	const api = { on: (_: string, fn: any) => { handler = fn; } };
	ask(api as any);
	const event = { toolName: "bash", input: { command: "git push" } };
	for (const mode of ["print", "rpc", "json"]) {
		assert.equal((await handler(event, { mode, hasUI: true })).block, true);
	}
	for (const approved of [false, true]) {
		const result = await handler(event, { mode: "tui", hasUI: true, ui: { confirm: async () => approved } });
		assert.equal(result?.block, approved ? undefined : true);
	}
	for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"]) {
		const old = process.env[key];
		try {
			process.env[key] = "1";
			handler = undefined;
			ask(api as any);
			assert.equal(handler, undefined);
		} finally {
			if (old === undefined) delete process.env[key]; else process.env[key] = old;
		}
	}
});
