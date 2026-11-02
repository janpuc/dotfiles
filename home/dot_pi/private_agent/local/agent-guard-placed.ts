// agent-guard for subagent children that pi-subagents places in a Rex tab, here or on another
// machine. Those children load this machine's packages instead of subagents.defaultExtensions,
// so the guard reaches them through this file. pi-subagents marks every placed child with
// PI_SUBAGENTS_HERDR_BRIDGE=1; in Jan's own sessions this does nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentGuard from "./agent-guard.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") agentGuard(pi);
}
