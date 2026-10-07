// AI attribution in git commits: models add `Co-authored-by: <model>` or "Generated with …" lines
// on their own, often copying an earlier commit in the repo. Strip them from `git commit` commands
// before they run; whatever cannot be removed cleanly is reported so the call can be blocked.

/**
 * Names and addresses that mark a co-author line as an AI model or agent. Model-shaped on purpose:
 * a person called Claude or Kimi co-authoring a commit keeps their line.
 */
const AI = String.raw`(?:@anthropic\.com|@openai\.com|\bClaude (?:Opus|Sonnet|Haiku|Fable|Code|Agent)\b|\bCodex\b|ChatGPT|\bGPT-?\d|MiniMax|\bGLM-?\d|\bKimi[- ]?K\d|\bGemini\b|\bCopilot\b|DeepSeek|\bQwen|\bopencode\b)`;
const COAUTHOR = String.raw`Co-authored-by:[^\n"']*${AI}[^\n"']*`;
const GENERATED = String.raw`(?:🤖\s*)?Generated (?:with|by) \[?(?:Claude|Codex|opencode|Pi)\b[^\n"']*`;

/** A whole `-m "…"` argument that is nothing but an AI trailer. */
const MESSAGE_ARG = new RegExp(String.raw`[ \t]+(?:-m|--message)(?:[ \t]+|=)(["'])\s*(?:${COAUTHOR}|${GENERATED})\s*\1`, "gi");
/** A line of a multi-line message or heredoc that is nothing but an AI trailer. */
const WHOLE_LINE = new RegExp(String.raw`^[ \t]*(?:${COAUTHOR}|${GENERATED})[ \t]*\r?\n`, "gim");
const ANY = new RegExp(String.raw`${COAUTHOR}|${GENERATED}`, "i");
const GIT_COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+)*[^\n;&|]*\bcommit\b/;

export interface TrailerFix {
	command: string;
	/** Set when an AI trailer is left that could not be removed without rewriting the message. */
	leftover?: string;
}

/** The command with AI attribution removed, or undefined when it is not a commit or has none. */
export function stripAiTrailers(command: string): TrailerFix | undefined {
	if (!GIT_COMMIT.test(command) || !ANY.test(command)) return undefined;
	// Blank lines this leaves at the end of a message are dropped by git's default cleanup.
	const out = command.replace(MESSAGE_ARG, "").replace(WHOLE_LINE, "");
	const left = ANY.exec(out);
	return { command: out, ...(left ? { leftover: left[0].trim() } : {}) };
}
