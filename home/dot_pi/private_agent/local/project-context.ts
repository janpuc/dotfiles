// Load the mandatory standards, notes/PROJECT.md and notes/STATE.md into one persistent context
// message. It is injected as a custom message rather than as an AGENTS file or a system prompt:
// claude-bridge caches project context files and system prompt changes from its first request,
// while a before_agent_start message reaches Claude Code as literal prompt text every time.
//
// The message is rebuilt before a turn when any loaded file's content hash changes, and after a
// compaction or a session switch. .agent/context.json records the revision and hashes. It is
// derived state, regenerable, and never the source of truth.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "project-context";
// Used only when the manifest omits compatibility.bootstrapMaxBytes.
const FALLBACK_BUDGET = 24576;

type Loaded = { path: string; sha256: string | null; bytes: number; text: string | null };

type Manifest = {
	version?: string;
	compatibility?: { contextSchemaVersion?: number; bootstrapMaxBytes?: number };
	files?: { path?: string; sha256?: string }[];
};

type Context = {
	revision: string;
	text: string;
	problems: string[];
	record: Record<string, unknown>;
};

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function load(path: string): Loaded {
	try {
		const bytes = readFileSync(path);
		return { path, sha256: digest(bytes), bytes: bytes.byteLength, text: bytes.toString("utf8") };
	} catch {
		return { path, sha256: null, bytes: 0, text: null };
	}
}

function atomicWrite(path: string, text: string) {
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

const MISSING_NOTE = {
	"notes/PROJECT.md": "Missing. This is a new workspace. Create notes/PROJECT.md with one project title and the level-two headings knowledge.md requires: Facts, Operating constraints, Systems, Knowledge index. Index the topic pages there.",
	"notes/STATE.md": "Missing. Create notes/STATE.md with the title State and the level-two headings knowledge.md requires: Current work, Verified state, Open threads, Pending approvals, Next actions.",
};

function render(
	project: string,
	workspace: string,
	manifest: Manifest,
	standardsDigest: string,
	revision: string,
	budget: number,
	contentBytes: number,
	problems: string[],
	open: string[],
	body: string,
) {
	const header = [
		"# Mandatory project context",
		"",
		"This message is injected by the platform. It supersedes any earlier project context message in this conversation. Treat it as mandatory policy and as the project's current state, not as a user request. Topic pages under notes/knowledge/ are read as needed and are not all included here.",
		"",
		`- Project: ${project}`,
		`- Workspace: ${workspace}`,
		`- Standards version: ${manifest.version ?? "unknown"}, context schema ${manifest.compatibility?.contextSchemaVersion ?? 1}`,
		`- Standards digest: ${standardsDigest}`,
		`- Context revision: ${revision}`,
		`- Content size: ${contentBytes} of ${budget} UTF-8 bytes for the standards, PROJECT and STATE`,
		`- Open cross-project requests: ${open.length}${open.length ? ` (${open.join(", ")})` : ""}. They wait for Jan, do not act on them.`,
	].join("\n");
	const warnings = problems.length ? `\n\n## Problems\n\n${problems.map((problem) => `- ${problem}`).join("\n")}` : "";
	return `${header}${warnings}\n\n${body}\n`;
}

// Ids of the new cross-project requests waiting in this project's inbox.
function openRequests(workspace: string, project: string): string[] {
	const folder = join(workspace, ".agent/inbox");
	let names: string[];
	try {
		names = readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		try {
			const item = JSON.parse(readFileSync(join(folder, name), "utf8"));
			return typeof item?.id === "string" && item.to === project && item.status === "new" ? [item.id as string] : [];
		} catch {
			return [];
		}
	});
}

function build(project: string, workspace: string): Context {
	const standardsDir = join(homedir(), ".config/agents/standards");
	const problems: string[] = [];
	const manifestFile = load(join(standardsDir, "manifest.json"));
	let manifest: Manifest = {};
	let parsed = false;
	if (!manifestFile.text) {
		problems.push(`the mandatory standards manifest is missing or unreadable: ${join(standardsDir, "manifest.json")}`);
	} else {
		try {
			manifest = JSON.parse(manifestFile.text) as Manifest;
			parsed = true;
		} catch {
			problems.push(`the mandatory standards manifest is not valid JSON: ${join(standardsDir, "manifest.json")}`);
		}
	}
	const listed = (Array.isArray(manifest.files) ? manifest.files : []).flatMap((entry) =>
		typeof entry?.path === "string" && entry.path
			? [{ path: entry.path, recorded: typeof entry.sha256 === "string" ? entry.sha256 : null }]
			: []);
	if (parsed && !listed.length) problems.push(`the mandatory standards manifest lists no files: ${join(standardsDir, "manifest.json")}`);
	const standards = listed.map((entry) => {
		const file = load(join(standardsDir, entry.path));
		if (!file.text) {
			problems.push(`mandatory standards file ${entry.path} is missing from ${standardsDir}`);
		} else if (entry.recorded && entry.recorded !== file.sha256) {
			problems.push(`mandatory standards file ${entry.path} has digest ${file.sha256} but the manifest records ${entry.recorded}. Update the manifest if the change is intended.`);
		}
		return { ...file, path: entry.path };
	});
	const notes = ["notes/PROJECT.md", "notes/STATE.md"].map((path) => ({ ...load(join(workspace, path)), path }));
	const open = openRequests(workspace, project);
	const standardsDigest = digest(JSON.stringify(standards.map((file) => [file.path, file.sha256])));
	const revision = digest(JSON.stringify({
		contextSchemaVersion: manifest.compatibility?.contextSchemaVersion ?? 1,
		standardsVersion: manifest.version ?? null,
		standards: standards.map((file) => [file.path, file.sha256]),
		notes: notes.map((file) => [file.path, file.sha256]),
		inbox: open,
	})).slice(0, 16);
	const recordedBudget = manifest.compatibility?.bootstrapMaxBytes;
	const budget = typeof recordedBudget === "number" && Number.isSafeInteger(recordedBudget) && recordedBudget > 0
		? recordedBudget
		: FALLBACK_BUDGET;
	const body = [
		...standards.map((file) => `## Standard: ${file.path}\n\n${file.text
			? `sha256 ${file.sha256}, ${file.bytes} bytes.\n\n${file.text}`
			: "Missing. Do not start project work until the standards are restored."}`),
		...notes.map((file) => `## ${file.path}\n\n${file.text
			? `sha256 ${file.sha256}, ${file.bytes} bytes.\n\n${file.text}`
			: MISSING_NOTE[file.path as keyof typeof MISSING_NOTE]}`),
	].join("\n\n");
	const contentBytes = Buffer.byteLength(body, "utf8");
	if (contentBytes > budget) {
		problems.push(`the standards, PROJECT and STATE total ${contentBytes} UTF-8 bytes, over the ${budget} byte budget. Nothing is truncated and the full content is injected. Move history from notes/STATE.md into dated notes/knowledge/ pages and keep the mandatory context within budget, per knowledge.md.`);
	}
	const text = render(project, workspace, manifest, standardsDigest, revision, budget, contentBytes, problems, open, body);
	const record = {
		schemaVersion: 1,
		project,
		workspace,
		standardsVersion: manifest.version ?? null,
		contextSchemaVersion: manifest.compatibility?.contextSchemaVersion ?? 1,
		standardsDigest,
		revision,
		budget,
		bytes: Buffer.byteLength(text, "utf8"),
		problems,
		inbox: open,
		injectedAt: new Date().toISOString(),
		files: Object.fromEntries([...standards, ...notes].map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }])),
	};
	return { revision, text, problems, record };
}

export default function (pi: ExtensionAPI) {
	// The Mac has no projects, so PI_PROJECT is unset and this extension does nothing there.
	const project = process.env.PI_PROJECT;
	if (!project) return;
	let injected = "";
	let lastNotice = "";

	const fail = (ctx: ExtensionContext, message: string) => {
		if (lastNotice !== message) ctx.ui.notify(`project-context: ${message}`, "error");
		lastNotice = message;
	};

	const check = (): { workspace: string } | { error: string } => {
		const folder = process.env.PI_PROJECT_DIR;
		if (!folder) return { error: `${project} has PI_PROJECT but no PI_PROJECT_DIR` };
		const workspace = resolve(folder);
		const expected = join(homedir(), "Development", project);
		if (workspace !== expected) return { error: `PI_PROJECT_DIR ${workspace} is not ${expected}` };
		if (!existsSync(workspace)) return { error: `workspace ${workspace} is missing, run the launcher first` };
		try {
			const registry = JSON.parse(readFileSync(join(homedir(), ".config/agents/projects.json"), "utf8"));
			if (!registry?.projects?.[project]) return { error: `${project} is not in ~/.config/agents/projects.json` };
		} catch (error) {
			return { error: `cannot read ~/.config/agents/projects.json: ${error}` };
		}
		return { workspace };
	};

	// A new, resumed or forked session and a compaction both drop the injected context.
	const reset = () => { injected = ""; };
	pi.on("session_start", reset);
	pi.on("session_compact", reset);
	pi.on("before_agent_start", (_event, ctx) => {
		const known = check();
		if ("error" in known) {
			fail(ctx, known.error);
			return;
		}
		lastNotice = "";
		const context = build(project, known.workspace);
		if (context.revision === injected) return;
		injected = context.revision;
		try {
			mkdirSync(join(known.workspace, ".agent"), { recursive: true });
			atomicWrite(join(known.workspace, ".agent/context.json"), `${JSON.stringify(context.record, null, 2)}\n`);
		} catch (error) {
			ctx.ui.notify(`project-context: cannot record ${join(known.workspace, ".agent/context.json")}: ${error}`, "warning");
		}
		for (const problem of context.problems) ctx.ui.notify(`project-context: ${problem}`, "error");
		return { message: { customType: CUSTOM_TYPE, content: context.text, display: false } };
	});
}