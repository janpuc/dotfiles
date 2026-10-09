// Real agent-loop batching, with a fake worker so overlap is observable without provider calls.
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workers from "../../home/dot_pi/shared/extensions/subagent/index.ts";

export default function batchTest(pi: ExtensionAPI) {
	workers(pi, async (request) => {
		const trace = request.files![0];
		await appendFile(trace, "child-start\n");
		await new Promise((done) => setTimeout(done, 100));
		await appendFile(trace, "child-end\n");
		return { state: "succeeded", output: "verified batch", model: request.model, tools: request.tools, turns: 1 };
	});
}
