// Run with Node >=22.19: node --test home/.system/pi-pocket-extensions/approvals.test.ts
// Fakes mirror Pi Pocket v0.11.0 / pi-durable 1.0.2's hook and per-call memo API.
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
const { default: create, sharedChange } = await import(dataUrl(stripTypeScriptTypes(source)));
imports.deregister();

// Every verb in the laptop guard, plus option prefixes, shell separators and API writes.
const blocked = [
    "git push origin main",
    "git -C /tmp/repo push",
    "git --git-dir=.git push",
    ...[
        "merge",
        "close",
        "reopen",
        "comment",
        "review",
        "create",
        "edit",
        "ready",
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
    ...[
        "apply",
        "create",
        "delete",
        "patch",
        "replace",
        "scale",
        "edit",
        "label",
        "annotate",
        "cordon",
        "uncordon",
        "drain",
        "taint",
        "autoscale",
        "expose",
        "run",
        "set",
    ].map((v) => `kubectl ${v} deployment test`),
    ...["restart", "undo", "pause", "resume"].map((v) => `kubectl rollout ${v} deployment/test`),
    "kubectl --context homelab -n default apply -f app.yaml",
    ...[
        "reconcile",
        "suspend",
        "resume",
        "create",
        "delete",
        "bootstrap",
        "install",
        "uninstall",
        "push",
        "tag",
    ].map((v) => `flux ${v} kustomization apps`),
    ...[
        "apply-config",
        "apply",
        "upgrade",
        "upgrade-k8s",
        "reboot",
        "reset",
        "shutdown",
        "edit",
        "patch",
        "bootstrap",
        "rotate-ca",
        "wipe",
    ].map((v) => `talosctl ${v}`),
    ...["remove-member", "leave", "forfeit-leadership", "defrag"].map((v) => `talosctl etcd ${v}`),
    ...["install", "upgrade", "uninstall", "rollback", "delete"].map((v) => `helm ${v} app`),
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
    "true; kubectl delete pod test",
    "/usr/bin/git push",
    "$(flux reconcile ks apps)",
    "`helm upgrade app`",
    "kubectl apply --dry-run=none -f app.yaml",
];
const allowed = [
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
    "mygit push",
    "echo git-push",
];
const haBlocked = [
    ...["POST", "PUT", "PATCH", "DELETE"].flatMap((v) => [
        `curl -X ${v} https://hass.janpuc.com/api/states/light.test`,
        `curl --request=${v} https://home-assistant.janpuc.com/api/states/light.test`,
        `curl -X${v} "$HA_URL/api/states/light.test"`,
    ]),
    ...["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F"].map(
        (v) => `curl ${v} '{}' "\${HA_URL}/api/services/light/turn_on"`,
    ),
    "curl -d'{}' https://hass.janpuc.com/api/services/light/turn_on",
    'curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" \\\n  --data \'{"entity_id":"light.office"}\' "$HA_URL/api/services/light/turn_on"',
    "curl -X 'POST' http://localhost:8123/api/services/light/turn_on",
    'curl --request POST "$HA_URL/api/services/light/turn_on" --dry-run',
    "wget --post-data='{}' https://home-assistant.janpuc.com/api/services/light/turn_on",
    "wget --method=POST --body-data='{}' https://hass.janpuc.com/api/states/light.test",
    "http POST $HA_URL/api/services/light/turn_on entity_id=light.test",
    "https PATCH ${HA_URL}/api/states/light.test state=on",
    "httpie $HA_URL/api/services/light/turn_on entity_id=light.test",
    "http $HA_URL/api/states/light.test state:=true",
    "true && /usr/bin/curl -X POST https://hass.janpuc.com/api/services/light/turn_on",
];
const haAllowed = [
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

test("approvals sharedChange: laptop shared-system writes and reads", () => {
    for (const command of blocked) assert.ok(sharedChange(command), command);
    for (const command of allowed) assert.equal(sharedChange(command), undefined, command);
    assert.equal(sharedChange("gh pr merge 42 --squash"), "merge a GitHub PR");
});
test("approvals sharedChange: Home Assistant writes and GET/HEAD reads", () => {
    for (const command of haBlocked) assert.ok(sharedChange(command), command);
    for (const command of haAllowed) assert.equal(sharedChange(command), undefined, command);
    assert.equal(sharedChange(haBlocked[13]), "call a Home Assistant service");
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
            reason: "This command will merge a GitHub PR. Ask Jan before running it.",
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
        arguments: { command: "kubectl delete pod test" },
    };
    const denied = await before(deniedCall, memoApi(deniedCall.id, context, memos), context);
    assert.match(denied.block, /Jan denied this bash call/);
    assert.match(denied.block, /change the cluster/);
    assert.match(denied.block, /kubectl delete pod test/);
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
            { id: "failed", name: "bash", arguments: { command: "git push" } },
            memoApi("failed", context),
            context,
        ),
        /cancelled/,
    );
});
