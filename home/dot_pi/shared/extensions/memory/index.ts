// Load pinned memini exactly once through a presentation-only adapter. No deployed package patch.
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { quietMemoryAPI } from "./quiet.ts";

export default async function memory(pi: ExtensionAPI) {
	if (process.env.PI_WORKER === "1" || !process.env.PI_MEMINI_STATE?.startsWith("ok")) return;
	const entry = join(getAgentDir(), "npm", "node_modules", "@eleboucher", "pi-memini", "dist", "index.js");
	try {
		const mod = await import(entry);
		await mod.default(quietMemoryAPI(pi));
	} catch (error) {
		pi.events.emit("memini:load-error", "memory extension unavailable; check the package installation");
		throw error; // Pi rolls back partial registrations and surfaces the real failure.
	}
}
