import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = new URL("../../home/", import.meta.url);
const template = readFileSync(new URL("dot_pi/private_agent/modify_settings.json.tmpl", source), "utf8");
const render = spawnSync("chezmoi", ["execute-template"], { cwd: source, input: template, encoding: "utf8" });
assert.equal(render.status, 0, render.stderr);
function merge(settings: object) {
	const result = spawnSync("zsh", ["-c", render.stdout], { input: JSON.stringify(settings), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}
const legacy = {
	packages: ["git:github.com/janpuc/pi-claude-bridge@0000000", "npm:pi-claude-bridge@0.9.1",
		"npm:pi-subagent-manager@0.18.0", { source: "npm:@eleboucher/pi-memini@0.7.30", extensions: ["old"] },
		"npm:pi-optchat@0.1.0", "npm:pi-title-glyphs@0.1.1", "npm:pi-extra@1.0.0",
		{ source: "npm:manual-filtered@1.2.3", extensions: ["manual.ts"] }],
	extensions: ["~/.pi/shared/extensions/subagent", "~/custom-extension"],
	prompts: ["~/.pi/shared/prompts", "~/custom-prompts"], skills: ["~/custom-skills"],
	lastChangelogVersion: "1.1.0", customSetting: true,
};

test("npm bridge replaces the git pin; manager and filtered memini are pinned", () => {
	const got = merge(legacy);
	assert.deepEqual(got.packages.filter((p: any) => JSON.stringify(p).includes("pi-claude-bridge")), ["npm:pi-claude-bridge@0.9.2"]);
	assert.deepEqual(got.packages.filter((p: any) => JSON.stringify(p).includes("pi-subagent-manager")), ["npm:pi-subagent-manager@0.19.0"]);
	assert.deepEqual(got.packages.find((p: any) => p.source?.includes("pi-memini")), { source: "npm:@eleboucher/pi-memini@0.7.34", extensions: [] });
	assert.ok(!JSON.stringify(got.packages).match(/pi-optchat|pi-title-glyphs/));
});

test("retired resources disappear while manual packages, resources and settings survive", () => {
	const got = merge(legacy);
	assert.deepEqual(got.extensions, ["~/.pi/shared/extensions/profile", "~/.pi/shared/extensions/memory", "~/custom-extension"]);
	assert.deepEqual(got.prompts, ["~/custom-prompts"]);
	assert.deepEqual(got.skills, ["~/.pi/shared/skills", "~/custom-skills"]);
	assert.ok(got.packages.includes("npm:pi-extra@1.0.0"));
	assert.deepEqual(got.packages.find((p: any) => p.source?.includes("manual-filtered")), legacy.packages.at(-1));
	assert.equal(got.customSetting, true);
	assert.equal(got.lastChangelogVersion, "1.1.0");
	assert.deepEqual(merge(got), got, "repeat merges are idempotent");
});

test("first-time settings use only managed packages and no managed prompts", () => {
	const got = merge({});
	assert.equal(got.packages.length, 4);
	assert.deepEqual(got.prompts, []);
	assert.equal(got.defaultProvider, "claude-bridge");
	assert.equal(got.defaultModel, "claude-opus-5-5");
});
