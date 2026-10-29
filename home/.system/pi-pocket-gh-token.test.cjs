// The token helper runs on aether as root-owned code for the pocket user. This test
// renders it with test paths and runs it against a fake curl and jq, so the repository
// list it asks for and its fallback are checked without touching GitHub.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, 'pi-pocket-gh-token'), 'utf8');

// A fake curl: the installations list, then an access token. The first token request can
// be made to fail like GitHub's 422 for a repository the installation does not have.
const curlMock = `#!/bin/sh
printf '%s\\n' "$*" >>"$CURL_LOG"
case "$*" in
    *"/access_tokens")
        if [ "\${GH_TOKEN_TEST_FAIL_FIRST:-0}" = 1 ] && [ "$(grep -c 'access_tokens' "$CURL_LOG")" = 1 ]; then
            echo "curl: (22) The requested URL returned error: 422 Unprocessable Entity" >&2
            exit 22
        fi
        printf '%s\\n' '{"token":"ghs_testtoken","id":1}'
        ;;
    *"/app/installations")
        printf '%s\\n' '[{"id":42,"account":{"login":"janpuc"}}]'
        ;;
    *)
        echo "fake curl: unexpected call: $*" >&2
        exit 22
        ;;
esac
`;
// A fake jq for the two filters the helper uses: the installation id and the token.
const jqMock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const filter = args[args.length - 1];
const input = fs.readFileSync(0, "utf8");
if (!input.trim()) process.exit(0);
if (filter.includes("map(select")) {
    const account = args[args.indexOf("--arg") + 2];
    const found = JSON.parse(input).find(i => i.account && i.account.login === account);
    if (found) process.stdout.write(String(found.id));
} else if (filter.includes(".token")) {
    const token = JSON.parse(input).token;
    if (token) process.stdout.write(token);
} else {
    process.stderr.write("fake jq: unsupported filter: " + filter + "\\n");
    process.exit(1);
}
`;

function fixture(t, { failFirst = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pocket-gh-token-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, "home");
    const conf = path.join(home, ".config", "pi-pocket");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(conf, { recursive: true });
    fs.mkdirSync(bin);
    // A synthetic App key: the helper only signs a JWT with it.
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(
        path.join(conf, "github-app.pem"),
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    fs.writeFileSync(path.join(conf, "github-app-client-id"), "Iv1.testclientid");
    fs.writeFileSync(path.join(bin, "curl"), curlMock, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "jq"), jqMock, { mode: 0o755 });
    const log = path.join(dir, "curl.log");
    // The helper's own paths are fixed; the test renders them.
    const rendered = path.join(dir, "pi-pocket-gh-token");
    fs.writeFileSync(
        rendered,
        script
            .replace(/^home=\/home\/pocket$/m, `home=${home}`)
            .replace(/^conf=\$home\/\.config\/pi-pocket$/m, `conf=${conf}`),
    );
    const result = spawnSync("sh", [rendered], {
        encoding: "utf8",
        env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
            CURL_LOG: log,
            GH_TOKEN_TEST_FAIL_FIRST: failFirst ? "1" : "0",
        },
    });
    const requests = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : [];
    return {
        dir,
        home,
        result,
        requests,
        tokens: requests.filter(line => line.includes("/access_tokens")),
        hosts: () => fs.readFileSync(path.join(home, ".config", "gh", "hosts.yml"), "utf8"),
    };
}

test("pi-pocket-gh-token asks for the Home Assistant repository and writes gh's config", t => {
    const f = fixture(t);
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.tokens.length, 1, f.requests.join("\n"));
    const body = f.tokens[0].match(/-d (\{.*\}) /);
    assert.ok(body, f.tokens[0]);
    assert.deepEqual(JSON.parse(body[1]).repositories, [
        "home-ops",
        "dotfiles",
        "BC250",
        "home-assistant",
    ]);
    assert.deepEqual(JSON.parse(body[1]).permissions, {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        statuses: "read",
        actions: "read",
    });
    assert.match(f.hosts(), /oauth_token: ghs_testtoken/);
    assert.equal(f.result.stderr, "");
});

test("pi-pocket-gh-token falls back to the older repositories when the installation lacks one", t => {
    const f = fixture(t, { failFirst: true });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(f.tokens.length, 2, f.requests.join("\n"));
    const first = JSON.parse(f.tokens[0].match(/-d (\{.*\}) /)[1]);
    const second = JSON.parse(f.tokens[1].match(/-d (\{.*\}) /)[1]);
    assert.ok(first.repositories.includes("home-assistant"));
    assert.deepEqual(second.repositories, ["home-ops", "dotfiles", "BC250"]);
    assert.deepEqual(second.permissions, first.permissions);
    // The log line says what Jan has to do, and gh keeps working.
    assert.match(f.result.stderr, /home-assistant/);
    assert.match(f.result.stderr, /janpuc-agent/);
    assert.match(f.hosts(), /oauth_token: ghs_testtoken/);
});
