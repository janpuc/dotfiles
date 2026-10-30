// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/approvals.test.ts
// Fakes mirror Pi Pocket v0.26.0 / pi-durable 1.4.0's hook and per-call memo API.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const durable = `
export const defineExtension = x => x;
export const section = (key, render) => ({key, render});
export const hook = (task, handlers) => ({task: task.definition.name, handlers});
export const ToolTask = {definition: {name: 'pi.tool'}};
`;
const dataUrl = (source: string) =>
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const imports = registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "@earendil-works/pi-durable")
            return { url: dataUrl(durable), shortCircuit: true };
        return next(specifier, context);
    },
});
const source = await readFile(new URL("./approvals.ts", import.meta.url), "utf8");
const { default: create, sharedChange, haServiceAllowed, pocketApi, explain } = await import(
    dataUrl(stripTypeScriptTypes(source))
);
imports.deregister();

// Every verb in the laptop guard, plus option prefixes, shell separators and API writes.
const blocked = [
    "pr-merge-request 42 " + "a".repeat(40) + " && gh pr merge 42 --squash",
    "pr-merge-request 42 " + "a".repeat(40) + "; gh api repos/janpuc/home-ops/pulls/42/merge -X PUT",
    "git push origin main",
    "git -C /tmp/repo push",
    "git --git-dir=.git push",
    ...[
        "merge",
        "close",
        "reopen",
        "review",
        "lock",
        "unlock",
    ].map((v) => `gh pr ${v} 42`),
    ...["create", "close", "reopen", "comment", "edit", "delete", "transfer", "lock", "pin"].map(
        (v) => `gh issue ${v} 42`,
    ),
    ...["create", "delete", "edit", "upload"].map((v) => `gh release ${v} v1`),
    ...["create", "delete", "edit", "rename", "archive", "fork", "sync"].map(
        (v) => `gh repo ${v} janpuc/home-ops`,
    ),
    ...["run", "enable", "disable"].map((v) => `gh workflow ${v} ci`),
    ...["rerun", "cancel", "delete"].map((v) => `gh run ${v} 1`),
    ...["secret", "variable", "label"].flatMap((kind) =>
        ["set", "create", "edit", "delete"].map((v) => `gh ${kind} ${v} test`),
    ),
    "gh -R janpuc/home-ops pr merge 42 --squash",
    ...["apply", "update", "destroy", "purge"].map((v) => `chezmoi ${v}`),
    ...["POST", "PUT", "PATCH", "DELETE"].flatMap((v) => [
        `gh api repos/janpuc/home-ops -X ${v}`,
        `gh api --method=${v} repos/janpuc/home-ops`,
    ]),
    ...["-f", "-F", "--field", "--raw-field", "--input"].map(
        (v) => `gh api repos/janpuc/home-ops ${v} body=value`,
    ),
    "gh api graphql -f query='mutation { test }'",
    "echo checking && git push",
    "true; gh pr merge 42 --squash",
    "/usr/bin/git push",
    "$(gh pr merge 42 --squash)",
    "`gh pr close 42`",
];
const allowed = [
    "pr-merge-request 42 " + "a".repeat(40),
    "/usr/local/sbin/pr-merge-request 42 " + "a".repeat(40),
    "git status",
    "git diff",
    "git commit -m local",
    "git fetch",
    "git pull",
    ...["list", "view", "checks", "diff"].map((v) => `gh pr ${v} 42`),
    "gh issue list",
    "gh release view",
    "gh run view",
    "gh repo view",
    "gh api repos/janpuc/home-ops",
    "gh api -X GET repos/janpuc/home-ops",
    "gh api --method=HEAD repos/janpuc/home-ops -f x=y",
    "gh api graphql -f query='{ viewer { login } }'",
    ...[
        "get pods -A",
        "describe pod test",
        "logs test",
        "get events",
        "rollout status deployment/test",
        "rollout history deployment/test",
    ].map((v) => `kubectl ${v}`),
    "kubectl --context homelab -n default get pods",
    "flux get all -A",
    "talosctl health",
    "talosctl etcd members",
    "helm list -A",
    "helm status app",
    "chezmoi diff",
    "chezmoi status",
    "kubectl apply --dry-run=client -f app.yaml",
    "helm upgrade --dry-run app",
    "git push --dry-run",
    "agent-push --dry-run",
    "mygit push",
    "echo git-push",
];
const haBlocked = [
    ...["POST", "PUT", "PATCH", "DELETE"].flatMap((v) => [
        `curl -X ${v} https://hass.janpuc.com/api/states/light.test`,
        `curl --request=${v} https://home-assistant.janpuc.com/api/states/light.test`,
        `curl -X${v} "$HA_URL/api/states/light.test"`,
    ]),
    "curl -X 'POST' http://localhost:8123/api/services/light/turn_on",
    'curl --request POST "$HA_URL/api/services/light/turn_on" --dry-run',
    'curl --request POST "$HA_URL/api/services/script/turn_on" --dry-run',
    "wget --post-data='{}' https://home-assistant.janpuc.com/api/services/light/turn_on",
    "wget --method=POST --body-data='{}' https://hass.janpuc.com/api/states/light.test",
    "http POST $HA_URL/api/services/light/turn_on entity_id=light.test",
    "https PATCH ${HA_URL}/api/states/light.test state=on",
    "httpie $HA_URL/api/services/light/turn_on entity_id=light.test",
    "http $HA_URL/api/states/light.test state:=true",
    "true && /usr/bin/curl -X POST https://hass.janpuc.com/api/services/light/turn_on",
];
// The services that need no phone prompt: lights, scenes and the reload services.
const haAllowedServices = [
    "light.turn_on",
    "light.turn_off",
    "light.toggle",
    "scene.turn_on",
    "automation.reload",
    "script.reload",
    "scene.reload",
    "homeassistant.reload_core_config",
    "homeassistant.reload_all",
    "group.reload",
    "template.reload",
    "input_boolean.reload",
    "input_select.reload",
    "input_number.reload",
    "input_text.reload",
    "input_datetime.reload",
    "input_button.reload",
    "timer.reload",
    "zone.reload",
];
const haServiceCall = (service: string) =>
    `curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" -H 'Content-Type: application/json' --data '{"entity_id":"light.office"}' "$HA_URL/api/services/${service.replace(".", "/")}"`;
const haAllowed = [
    // A light, a scene or a reload: one simple curl, one service URL, no phone prompt.
    ...haAllowedServices.map((service) => haServiceCall(service)),
    ...["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F"].map(
        (v) => `curl ${v} '{}' "\${HA_URL}/api/services/light/turn_on"`,
    ),
    "curl -X POST \"$HA_URL/api/services/light/turn_on\"",
    "curl -X POST https://hass.janpuc.com/api/services/light/turn_on",
    "curl --request POST \"${HA_URL}/api/services/scene/turn_on\"",
    "curl -d'{\"entity_id\":\"light.office\"}' https://hass.janpuc.com/api/services/light/turn_on",
    'curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" \\\n  --data \'{"entity_id":"light.office"}\' "$HA_URL/api/services/light/turn_on"',
    "curl https://hass.janpuc.com/api/states",
    "curl -X GET $HA_URL/api/states/light.test",
    "curl --request=HEAD ${HA_URL}/api/states",
    "curl -I https://home-assistant.janpuc.com/api/states",
    "curl -G --data 'filter=test' $HA_URL/api/states",
    "curl -X GET --data '{}' $HA_URL/api/states",
    "curl --json '{}' https://unrelated.example/api/states",
    "curl -X POST https://example.com/other",
    "wget $HA_URL/api/states",
    "wget --spider https://hass.janpuc.com/api/states",
    "http GET $HA_URL/api/states",
    "https HEAD ${HA_URL}/api/states",
    "http GET $HA_URL/api/states filter=test",
    "curl $HA_URL/api/services/light/turn_on",
    "curl https://hass.janpuc.com/api/states; curl -X POST https://example.com/other",
];

test("approvals drop-in declares extension API 2", () => {
    assert.equal(pocketApi, 2);
});

test("approvals sharedChange: laptop shared-system writes and reads", () => {
    for (const command of blocked) assert.ok(sharedChange(command), command);
    for (const command of allowed) assert.equal(sharedChange(command), undefined, command);
    assert.equal(sharedChange("gh pr merge 42 --squash"), "merge a GitHub PR");
});
test("approvals sharedChange: Home Assistant writes and GET/HEAD reads", () => {
    for (const command of haBlocked) assert.ok(sharedChange(command), command);
    for (const command of haAllowed) assert.equal(sharedChange(command), undefined, command);
    assert.equal(
        sharedChange('curl -X POST "$HA_URL/api/services/script/turn_on"'),
        "call a Home Assistant service",
    );
});

test("approvals sharedChange: lights, scenes and reloads need no phone prompt", () => {
    for (const service of haAllowedServices) {
        const command = haServiceCall(service);
        assert.equal(sharedChange(command), undefined, command);
        assert.equal(haServiceAllowed(command), true, command);
    }
    // The same call in the shapes an agent writes them.
    for (const command of [
        'curl -X POST "$HA_URL/api/services/light/turn_on"',
        "curl -X POST https://hass.janpuc.com/api/services/light/turn_off",
        "curl -X POST https://home-assistant.janpuc.com/api/services/light/toggle",
        'curl --request POST "${HA_URL}/api/services/scene/turn_on"',
        "curl --data '{}' $HA_URL/api/services/homeassistant/reload_all",
    ]) {
        assert.equal(sharedChange(command), undefined, command);
        assert.equal(haServiceAllowed(command), true, command);
    }
});

test("approvals sharedChange: every other Home Assistant call still asks Jan", () => {
    for (const service of [
        "script.turn_on",
        "script.turn_off",
        "script.reload_all",
        "switch.turn_off",
        "switch.turn_on",
        "homeassistant.restart",
        "homeassistant.stop",
        "homeassistant.update_entity",
        "homeassistant.toggle",
        "fan.set_speed",
        "climate.set_temperature",
        "media_player.turn_on",
        "input_boolean.turn_on",
        "light.turn_on_with_brightness",
        "notify.mobile_app",
    ]) {
        const command = haServiceCall(service);
        assert.ok(sharedChange(command), command);
        assert.equal(haServiceAllowed(command), false, command);
    }
});

test("approvals sharedChange: the Home Assistant exemption needs one simple curl call", () => {
    const ask = [
        // Chained commands.
        'curl -X POST "$HA_URL/api/services/light/turn_on" && curl -X POST "$HA_URL/api/services/script/turn_on"',
        'curl -X POST "$HA_URL/api/services/light/turn_on"; curl -X POST "$HA_URL/api/services/script/turn_on"',
        'curl -X POST "$HA_URL/api/services/light/turn_on" | tee /tmp/lights',
        'curl -X POST "$HA_URL/api/services/light/turn_on" && git push',
        // Two service URLs.
        'curl -X POST "$HA_URL/api/services/light/turn_on" "$HA_URL/api/services/script/turn_on"',
        'curl -X POST "$HA_URL/api/services/light/turn_on?next=/api/services/script/turn_on"',
        // Substitution, also inside quotes.
        'curl -X POST "$(echo $HA_URL)/api/services/light/turn_on"',
        'curl -X POST "$HA_URL/api/services/light/turn_on" $(id)',
        'curl -X POST "`id` $HA_URL/api/services/light/turn_on"',
        // Quoting tricks.
        'curl -X POST "$HA_URL/api/services/light/turn_on" "',
        'curl -X POST "$HA_URL/api/services/light/turn_on\'; rm -rf /"',
        'curl -X POST "$HA_URL/api/services/light/turn_on" > /tmp/lights',
        // Another host, another tool, another request.
        "curl -X POST http://localhost:8123/api/services/light/turn_on",
        "curl -X POST https://example.com/api/services/light/turn_on",
        "wget --post-data='{}' https://hass.janpuc.com/api/services/light/turn_on",
        'curl -X POST --url "$HA_URL/api/services/light/turn_on"',
        'curl -X POST --config /tmp/curlrc "$HA_URL/api/services/light/turn_on"',
        'curl -X POST --next -X POST "$HA_URL/api/services/script/turn_on" "$HA_URL/api/services/light/turn_on"',
        // Short and attached forms of --config and --next, and a GET that a config file could turn into a POST.
        'curl -K /tmp/curlrc "$HA_URL/api/services/light/turn_on"',
        'curl -sK /tmp/curlrc "$HA_URL/api/services/light/turn_on"',
        'curl --config=/tmp/curlrc "$HA_URL/api/services/light/turn_on"',
        'curl -X POST "$HA_URL/api/services/light/turn_on" -: -X POST "$HA_URL/api/states/x"',
        // A dry-run flag is not a curl option: not a plain service call.
        'curl -X POST "$HA_URL/api/services/light/turn_on" --dry-run',
    ];
    for (const command of ask) {
        assert.ok(sharedChange(command), command);
        assert.equal(haServiceAllowed(command), false, command);
    }
});

function memoApi(callId: string, context: object, memos = new Map()) {
    return {
        conversationId: 1,
        taskId: 7,
        callId,
        memo: async (name, value, writeContext) => {
            assert.equal(writeContext ?? value, context);
            const key = `${callId}:${name}`;
            if (writeContext !== undefined && !memos.has(key)) memos.set(key, value);
            return memos.get(key);
        },
    };
}

test("approvals beforeTool: ask once per call, persist allow/deny on replay, pass reads untouched", async () => {
    const context = {};
    const requests: any[] = [];
    let allow = true;
    const extension = create({
        approvals: {
            request: async (asked, ctx) => {
                assert.equal(ctx, context);
                requests.push(asked);
                return { allow, by: "Jan" };
            },
        },
    });
    assert.equal(extension.name, "approvals");
    assert.equal(extension.hooks[0].task, "pi.tool");
    const prompt = extension.sections[0].render();
    assert.match(prompt, /Jan on his phone/);
    assert.match(prompt, /State plainly/);
    assert.match(prompt, /Never try to get around a denial/);
    const before = extension.hooks[0].handlers.beforeTool;
    const call = {
        id: "call-1",
        name: "bash",
        arguments: { command: " \n gh pr merge 42\n--squash \n" },
    };
    const memos = new Map();
    const api = memoApi(call.id, context, memos);
    assert.equal(await before(call, api, context), undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(
        { ...requests[0], createdAt: 0 },
        {
            id: "7:call-1",
            conversationId: 1,
            taskId: 7,
            callId: "call-1",
            tool: "bash",
            subject: "gh pr merge 42 --squash",
            reason: "Merge pull request #42 in the current repository. Allow only if you expected this.",
            createdAt: 0,
        },
    );
    assert.ok(Number.isFinite(requests[0].createdAt));
    allow = false;
    // A rebuilt API with the same durable memos simulates recovery after a restart.
    assert.equal(await before(call, memoApi(call.id, context, memos), context), undefined);
    assert.equal(requests.length, 1, "replay uses the original allow answer");
    const deniedCall = {
        ...call,
        id: "call-2",
        arguments: { command: "gh pr merge 42 -R janpuc/home-ops --squash" },
    };
    const denied = await before(deniedCall, memoApi(deniedCall.id, context, memos), context);
    assert.match(denied.block, /Jan denied this bash call/);
    assert.match(denied.block, /Merge pull request #42 in janpuc\/home-ops/);
    assert.match(denied.block, /gh pr merge 42/);
    allow = true;
    assert.deepEqual(
        await before(deniedCall, memoApi(deniedCall.id, context, memos), context),
        denied,
    );
    assert.equal(requests.length, 2, "same task, distinct calls each ask once");
    for (const command of [...allowed, ...haAllowed]) {
        assert.equal(await before({ ...call, arguments: { command } }, api, context), undefined);
    }
    assert.equal(await before({ ...call, name: "read" }, api, context), undefined);
    assert.equal(await before({ ...call, arguments: {} }, api, context), undefined);
    assert.equal(requests.length, 2, "reads and other tools never request approval");
});

test("approvals beforeTool: approval errors propagate instead of letting a write run", async () => {
    const context = {};
    const extension = create({
        approvals: {
            request: async () => {
                throw new Error("cancelled");
            },
        },
    });
    await assert.rejects(
        extension.hooks[0].handlers.beforeTool(
            { id: "failed", name: "bash", arguments: { command: "gh pr merge 42 --squash" } },
            memoApi("failed", context),
            context,
        ),
        /cancelled/,
    );
});

test('approvals hook: each lane A/B merge call asks Jan', async () => {
    let asked = 0;
    const extension = create({ approvals: { request: async () => { asked++; return {allow: false, by: 'Jan'}; } } });
    const before = extension.hooks[0].handlers.beforeTool, context = {};
    for (const id of ['A', 'B']) {
        const call = { id, name: 'bash', arguments: {
            command: `gh pr merge 42 -R janpuc/home-ops --squash --match-head-commit ${'a'.repeat(40)}`,
        } };
        assert.match((await before(call, memoApi(id, context), context)).block, /Jan denied/);
    }
    assert.equal(asked, 2, 'no lane exception: distinct merge calls each ask');
});

test('approvals: malformed merge dry-run/chaining cannot use the generic dry-run exemption', async () => {
    const commands = [
        'gh pr merge 42 -R janpuc/home-ops --squash --dry-run',
        'gh pr merge 42 -R janpuc/home-ops --squash --admin; echo --dry-run',
    ];
    let asked = 0;
    const extension = create({ approvals: { request: async () => { asked++; return {allow:false,by:'Jan'}; } } });
    for (const [i, command] of commands.entries()) {
        assert.equal(sharedChange(command), 'merge a GitHub PR');
        const context = {};
        assert.match((await extension.hooks[0].handlers.beforeTool({id:String(i),name:'bash',arguments:{command}},
            memoApi(String(i),context),context)).block, /Jan denied/);
    }
    assert.equal(asked,2);
});

test('approvals sharedChange: dry-run cannot exempt chains or shell expansions', () => {
    for (const operator of [';', '&&', '||', '|', '&', '\n', '\r\n']) {
        for (const command of [`git push ${operator} echo --dry-run`, `echo --dry-run ${operator} git push`])
            assert.equal(sharedChange(command), 'push git commits', command);
    }
    for (const command of [
        'git push $(echo --dry-run)', 'echo --dry-run $(git push)',
        'git push `echo --dry-run`', 'echo --dry-run `git push`',
        'git push <(echo --dry-run)', 'echo --dry-run <(git push)',
        'git push >(echo --dry-run)', 'echo --dry-run >(git push)',
        'git push # --dry-run', 'git push "text --dry-run"',
        'git push --dry-run=none', 'git push --dry-run-not-a-flag',
        'sh -c git push --dry-run', 'bash -c git push --dry-run',
    ]) assert.equal(sharedChange(command), 'push git commits', command);
    for (const command of ['gh pr merge 42 --dry-run', 'git push --dry-run=none'])
        assert.ok(sharedChange(command), command);
    for (const command of ['agent-push --dry-run', 'git push --dry-run',
        'kubectl apply --dry-run=client -f x', 'kubectl apply --dry-run=server -f x'])
        assert.equal(sharedChange(command), undefined, command);
});

test('approvals sharedChange: quotes and escapes do not hide writes', () => {
    for (const command of [
        '"git" push', "'git' push", String.raw`g\it push`, 'git "push"',
        '"gh" pr merge 42 --dry-run', "gh 'pr' merge 42", String.raw`gh pr m\erge 42`,
        '"gh" pr close 42', String.raw`gh pr cl\ose 42`,
        '"gh" api repos/janpuc/home-ops -X POST',
        // A quoted curl is still a curl: the exemption follows the service, not the spelling.
        '"curl" -X POST "$HA_URL/api/services/script/turn_on"'])
        assert.ok(sharedChange(command), command);
});

test('approvals sharedChange: branch pushes and PR authoring do not ask (Jan, 2026-10-29)', () => {
    for (const command of ['agent-push', '/usr/local/sbin/agent-push', 'cd repo && agent-push',
        'gh pr create -R janpuc/home-ops --base main --head agent/x --title t --body-file b.md',
        'gh pr edit 42 --title t', 'gh pr comment 42 --body ok', 'gh pr ready 42'])
        assert.equal(sharedChange(command), undefined, command);
    for (const command of ['git push origin agent/x', 'gh pr merge 42 --squash', 'gh pr close 42',
        'gh pr review 42 --approve', 'agent-push && git push', 'agent-push; gh pr close 42'])
        assert.ok(sharedChange(command), command);
});

test('approvals hook: a raw git push is refused without asking Jan (2026-10-30)', async () => {
    let asked = 0;
    const ext = create({ approvals: { request: async () => { asked++; return { allow: true, by: 'Jan' }; } } });
    const handlers = ext.hooks[0].handlers;
    const context = {};
    for (const command of ['git push -u origin agent/x', 'cd /home/pocket/work/home-ops && git push origin agent/x',
        'git -C ~/work/home-ops push', '"git" push', 'git commit -m x; git push']) {
        const result = await handlers.beforeTool({ name: 'bash', id: 'c' + command.length, arguments: { command } }, memoApi('c' + command.length, context), context);
        assert.match(result.block, /agent-push/, command);
    }
    assert.equal(asked, 0);
    const merge = await handlers.beforeTool({ name: 'bash', id: 'm1', arguments: { command: 'gh pr merge 42 --squash' } }, memoApi('m1', context), context);
    assert.equal(merge, undefined);
    assert.equal(asked, 1);
});

test('approvals sharedChange: cluster CLIs no longer ask; RBAC is the boundary (2026-10-30)', () => {
    for (const command of ['kubectl delete pod test', 'kubectl patch ds cilium -n kube-system --type=json -p x',
        'flux reconcile ks apps', 'talosctl reboot', 'helm upgrade app',
        "awk '{printf \"kubectl patch %s\\n\", $1}' list > cmds.txt"])
        assert.equal(sharedChange(command), undefined, command);
});

test('approvals explain: plain lines for the card', async () => {
    assert.equal(explain('gh pr merge 1593 -R janpuc/home-ops --squash', 'merge a GitHub PR'), 'Merge pull request #1593 in janpuc/home-ops.');
    assert.equal(explain('gh pr close 42 -R janpuc/dotfiles', 'write to GitHub'), 'GitHub: close pr 42 in janpuc/dotfiles.');
    assert.equal(explain('curl -X POST "$HA_URL/api/services/lock/unlock" -d \'{"entity_id":"lock.front_door"}\'', 'call a Home Assistant service'), 'Home Assistant: run lock.unlock on lock.front_door.');
});

test('approvals hook: hand-built GitHub commits are refused without asking (2026-10-30)', async () => {
    let asked = 0;
    const ext = create({ approvals: { request: async () => { asked++; return { allow: true, by: 'Jan' }; } } });
    const handlers = ext.hooks[0].handlers;
    const context = {};
    for (const command of ['gh api graphql --input /tmp/mutation.json -f query="mutation { createCommitOnBranch(input: $i) { commit { oid } } }"',
        'gh api -X PUT repos/janpuc/home-ops/contents/kubernetes/x.yaml -f message=m -f content=Zm9v',
        'gh api -X POST repos/janpuc/home-ops/git/refs -f ref=refs/heads/x -f sha=abc']) {
        const result = await handlers.beforeTool({ name: 'bash', id: 'h' + command.length, arguments: { command } }, memoApi('h' + command.length, context), context);
        assert.match(result.block, /agent-push/, command);
    }
    assert.equal(asked, 0);
});

test('approvals hook: closing a PR that is not provably the agent\'s still asks', async () => {
    let asked = 0;
    const ext = create({ approvals: { request: async () => { asked++; return { allow: true, by: 'Jan' }; } } });
    const handlers = ext.hooks[0].handlers;
    const context = {};
    // No gh on PATH: the author lookup fails, so it must ask (fail closed).
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    for (const command of ['gh pr close 1682 -R janpuc/home-ops --comment done', 'gh pr close 5', 'gh pr close 5 -R janpuc/home-ops; gh pr close 6 -R janpuc/home-ops']) {
        await handlers.beforeTool({ name: 'bash', id: 'c' + command.length, arguments: { command } }, memoApi('c' + command.length, context), context);
    }
    process.env.PATH = path;
    assert.equal(asked, 3);
});
