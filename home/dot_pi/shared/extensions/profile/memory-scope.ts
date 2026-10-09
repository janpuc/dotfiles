// Memory scope is independent of models, accounts and tool approvals.
export type Profile = "personal" | "work";

const MEMORY_WRITES = new Set(["memory_remember", "memory_update", "memory_forget"]);
const isWorkNs = (ns: string) => ns === "work" || ns.startsWith("work/");

/**
 * Block reason for a pi-memini tool call, or undefined to allow it. Work reads and writes stay in
 * work/*, apart from reading the personal home overlay; Personal never touches work/*. pi-memini's
 * `visibility: "personal"` writes into the home namespace, so Work may not use it.
 */
export function memoryToolBlock(
	profile: Profile,
	tool: string,
	args: Record<string, unknown> | undefined,
	opts: { home?: string; memoryOff?: string },
): string | undefined {
	if (!tool.startsWith("memory_")) return undefined;
	if (opts.memoryOff) return `memory is off for this session (${opts.memoryOff})`;
	const ns = typeof args?.namespace === "string" ? args.namespace.trim() : "";
	const visibility = typeof args?.visibility === "string" ? args.visibility.trim() : "";
	if (profile === "work") {
		if (ns && !isWorkNs(ns)) {
			if (MEMORY_WRITES.has(tool) || ns !== opts.home)
				return `Work sessions may only ${MEMORY_WRITES.has(tool) ? "write" : "read"} work/* memory${MEMORY_WRITES.has(tool) ? "" : " and the personal home overlay"} (got ${ns})`;
		}
		if (visibility && visibility !== "project" && !isWorkNs(visibility))
			return `Work memories stay in work/* (visibility ${visibility} is not allowed)`;
	} else {
		if (ns && isWorkNs(ns)) return `Personal sessions cannot access Work memory (${ns})`;
		if (visibility && isWorkNs(visibility)) return `Personal sessions cannot write Work memory (${visibility})`;
	}
	return undefined;
}

