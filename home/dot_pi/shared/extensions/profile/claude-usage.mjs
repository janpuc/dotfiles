// Print the Claude plan usage of the login in $CLAUDE_CONFIG_DIR as JSON, through the Claude
// Agent SDK's /usage data (the same call Claude Code's /usage makes). No prompt is sent and the
// OAuth token never leaves Claude Code. Usage: node claude-usage.mjs <path to sdk.mjs>
// The SDK marks this API experimental; on failure the caller treats Claude usage as unknown.

const sdk = await import(process.argv[2]);
let release;
const idle = (async function* () {
	await new Promise((resolve) => (release = resolve));
})();
const q = sdk.query({ prompt: idle, options: { settingSources: [], strictMcpConfig: true, tools: [], persistSession: false } });
try {
	const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
	process.stdout.write(JSON.stringify({ subscription_type: u.subscription_type, rate_limits_available: u.rate_limits_available, rate_limits: u.rate_limits }));
} catch (e) {
	process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }));
}
release?.();
q.close?.();
process.exit(0);
