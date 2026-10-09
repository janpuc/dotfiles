import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const config = new URL("../../home/dot_pi/private_agent/private_subagent-manager/", import.meta.url);
// Reuse Pi's installed YAML parser; do not install or execute the manager.
const require = createRequire(process.env.PI_AI_RETRY_JS!);
const { parseDocument } = require("yaml");
const read = (path: string) => readFileSync(new URL(path, config), "utf8");

test("manager settings are valid JSON with the agreed values", () => {
	assert.deepEqual(JSON.parse(read("settings.json")), {
		subagentMode: "opportunistic", widgetMode: "full", nerdFontIcons: true,
		loaderStyle: "braille", finalRecap: false, modelSelection: "pick-first-available",
		toolFiltering: "allowed", maxLevels: 2, maxConcurrent: 2,
	});
});

const common = ["read", "grep", "find", "ls", "agent_update", "agent_pause"];
const sol = ["openai/gpt-6.1-sol"];
const flash = ["opencode-go/deepseek-v4.1-flash", "minimax/MiniMax-M3"];
const roles = {
	architect: { models: ["claude-bridge/claude-fable-5-1"], tools: common },
	coder: { models: sol, tools: [...common, "bash", "edit", "write"] },
	researcher: { models: flash, tools: [...common, "web_search", "fetch_content", "get_search_content"] },
	reviewer: { models: sol, tools: common }, tasker: { models: flash, tools: common },
	writer: { models: sol, tools: common },
};

test("manager contains exactly the six configured types", () => {
	assert.deepEqual(readdirSync(new URL("private_agents/", config)).sort(), Object.keys(roles).map(name => `${name}.yml`).sort());
});

for (const [name, expected] of Object.entries(roles)) {
	test(`${name} YAML is valid, models are ordered, and tools are exactly bounded`, () => {
		const doc = parseDocument(read(`private_agents/${name}.yml`), { uniqueKeys: true });
		assert.deepEqual(doc.errors, []);
		const agent = doc.toJS();
		assert.deepEqual(agent, { name, models: expected.models, tools: { allow: expected.tools, block: [] } });
		assert.ok(agent.tools.allow.every((tool: string) => !tool.startsWith("memory_")));
		for (const tool of ["bash", "edit", "write"]) assert.equal(agent.tools.allow.includes(tool), name === "coder");
	});
}
