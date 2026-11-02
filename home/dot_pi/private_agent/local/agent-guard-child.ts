// agent-guard in every subagent child, and nowhere else. Children load this machine's packages
// (there is no subagents.defaultExtensions: pi-subagents cannot hand local extension paths to a
// child it places in a Rex tab), so the guard comes in through this file. pi-subagents marks a
// background child with PI_SUBAGENT_CHILD=1 and a child in a Rex tab, here or on another machine,
// with PI_SUBAGENTS_HERDR_BRIDGE=1; in Jan's own sessions this does nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentGuard from "./agent-guard.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") agentGuard(pi);
}
