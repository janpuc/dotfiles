// Real RPC EOF regression. The parent dies before the first 2s watchdog tick.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { workerEnvironment } from "../../home/dot_pi/shared/extensions/subagent/worker-policy.ts";

export default function orphanTest(pi: ExtensionAPI) {
	const marker = process.env.PI_TEST_ORPHAN_MARKER!;
	if (process.env.PI_WORKER === "1") {
		pi.on("session_start", () => {
			const ids = { worker: process.pid, parent: process.ppid, started: Date.now() };
			spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({...${JSON.stringify(ids)},descendant:process.pid}));setInterval(()=>{},1000);`], { stdio: "ignore" });
		});
		return;
	}
	pi.registerCommand("test-worker-orphan", {
		description: "Terminate the fake parent with a live piped RPC child",
		handler: async (_args, ctx) => {
			const prompt = join(ctx.cwd, "orphan-system.md"); writeFileSync(prompt, "Minimal offline orphan test.", { mode: 0o600 });
			const cli = realpathSync(process.argv[1]);
			spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-approve", "--no-tools",
				"--model", "litellm/opencode-go/deepseek-v4.1-flash", "--models", "litellm/opencode-go/deepseek-v4.1-flash", "--system-prompt", prompt,
				"-e", join(process.env.HOME!, ".pi/shared/extensions/subagent/bootstrap.ts"), "-e", fileURLToPath(import.meta.url)],
				{ cwd: ctx.cwd, detached: true, stdio: ["pipe", "ignore", "ignore"], env: workerEnvironment(process.env, [], prompt) });
			for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((done) => setTimeout(done, 25));
			if (!existsSync(marker)) throw new Error("Orphan RPC fixture did not initialize");
			process.kill(process.pid, "SIGKILL"); // EOF closes its owned child's stdin.
		},
	});
}
