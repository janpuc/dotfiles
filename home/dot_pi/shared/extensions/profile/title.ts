import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One timer per extension instance; Pi shutdown (including reload) disposes it. */
export function registerTitle(pi: ExtensionAPI) {
	const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
	const title = (ctx: any, glyph: string) => {
		if (ctx.hasUI) ctx.ui.setTitle(`${glyph} ${basename(ctx.cwd).replace(/[\x00-\x1f\x7f-\x9f]/g, "")}`);
	};
	pi.on("session_start", (_event, ctx) => { stop(); title(ctx, "✓"); });
	pi.on("agent_start", (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		let frame = 0;
		const draw = () => title(ctx, frames[frame++ % frames.length]);
		draw();
		timer = setInterval(draw, 100);
		timer.unref?.();
	});
	pi.on("agent_settled", (_event, ctx) => { stop(); title(ctx, "✓"); });
	pi.on("session_shutdown", stop);
}
