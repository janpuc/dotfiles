// Detachable terminal Pi on the aether server. The launcher runs an interactive Pi under dtach
// (PI_DETACH_ID, PI_DETACH_DIR), so an SSH drop only ends the dtach client and the run carries on.
// This side writes what `pi-attach` lists (<dir>/<id>.json) and repaints on reattach.
//
// A new terminal attaching to the old pty has none of the modes Pi set up at start, and Pi's
// renderer skips lines it believes are unchanged. `pi-attach` therefore sends SIGUSR2 once
// attached, and Pi replays its terminal setup (alternate screen, no autowrap, mouse, bracketed
// paste, the keyboard protocol it negotiated) and forces a full render. Verified on aether.

import { rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface DetachInfo {
	id: string;
	dir: string;
}

export function detachInfo(env: NodeJS.ProcessEnv = process.env): DetachInfo | undefined {
	const id = env.PI_DETACH_ID, dir = env.PI_DETACH_DIR;
	return id && dir && /^[\w.-]+$/.test(id) ? { id, dir } : undefined;
}

export function writeMeta(d: DetachInfo, meta: { pid: number; cwd: string; profile: string; session?: string; name?: string; started: string }): void {
	const file = join(d.dir, `${d.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
	renameSync(tmp, file);
}

export function removeMeta(d: DetachInfo): void {
	rmSync(join(d.dir, `${d.id}.json`), { force: true });
}

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const BRACKETED_PASTE = "\x1b[?2004h";
const KITTY_KEYBOARD_FLAGS = "\x1b[>7u";
const MODIFY_OTHER_KEYS = "\x1b[>4;2m";

/** The setup a freshly attached terminal needs, given the TUI's current state. */
export function terminalSetup(tui: { altScreenActive?: boolean; mouseEnabled?: boolean; terminal?: { kittyProtocolActive?: boolean; modifyOtherKeysActive?: boolean } }): string {
	let seq = "";
	if (tui.altScreenActive) seq += ENTER_ALT_SCREEN + DISABLE_AUTOWRAP + (tui.mouseEnabled ? ALL_MOTION_MOUSE : "");
	seq += BRACKETED_PASTE;
	if (tui.terminal?.kittyProtocolActive) seq += KITTY_KEYBOARD_FLAGS;
	else if (tui.terminal?.modifyOtherKeysActive) seq += MODIFY_OTHER_KEYS;
	return `${seq}\x1b[2J\x1b[H\x1b[?25l`;
}

/** Repaint `tui` on a terminal that just attached. */
export function repaint(tui: any): void {
	if (!tui?.terminal) return;
	tui.terminal.write(terminalSetup(tui));
	tui.requestRender(true);
}
