// Terminal notifications: Pi finished a run that took a while, or a policy prompt is waiting.
// OSC 777 (Ghostty, iTerm2, WezTerm; passes through SSH, so aether sessions notify the laptop) or
// OSC 99 (Kitty). Only when stdout is a terminal: in RPC mode (T3) stdout carries the protocol and
// T3 notifies on its own, and print mode has nobody waiting.

/** Runs shorter than this finish while you are still looking. PI_NOTIFY_AFTER (seconds) overrides it. */
const DEFAULT_AFTER_S = 30;

export function notifyAfterMs(env: NodeJS.ProcessEnv = process.env): number {
	const s = Number(env.PI_NOTIFY_AFTER);
	return (Number.isFinite(s) && s >= 0 ? s : DEFAULT_AFTER_S) * 1000;
}

/** The escape sequence for one notification; text is stripped of control characters and `;`. */
export function notificationSequence(title: string, body: string, env: NodeJS.ProcessEnv = process.env): string {
	const clean = (s: string) => s.replace(/[\x00-\x1f\x7f;]/g, " ").slice(0, 200);
	return env.KITTY_WINDOW_ID
		? `\x1b]99;i=1:d=0;${clean(title)}\x1b\\\x1b]99;i=1:p=body;${clean(body)}\x1b\\`
		: `\x1b]777;notify;${clean(title)};${clean(body)}\x07`;
}

export function notify(title: string, body: string): void {
	if (!process.stdout.isTTY || process.env.PI_NOTIFY === "off") return;
	process.stdout.write(notificationSequence(title, body));
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
