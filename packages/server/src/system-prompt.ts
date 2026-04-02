import path from "node:path";
import type { InstructionFile } from "./instructions";
import type { Skill } from "./skill/skill";

const TOOL_DESCRIPTIONS: Record<string, string> = {
	read_file: "Read the contents of a file.",
	list_directory: "List the contents of a directory.",
	write_file: "Create or overwrite a file. Parent directories are created automatically.",
	edit_file: "Edit a file by replacing an exact string with new content. The old_string must match exactly one location.",
	grep_search: "Search file contents for a pattern. Returns matching lines with paths and line numbers.",
	bash: "Execute a bash command in the project directory. Use for running tests, builds, linters, git, and other shell operations.",
	sqlite3:
		"Execute a SQL query against a SQLite database in the project directory. Use for querying, creating, and modifying SQLite databases without needing sqlite3 installed on the system.",
	task: "Launch a subagent to handle complex, multi-step tasks autonomously. Each subagent runs independently with its own tool access (except task). Use for tasks that can run in isolation — exploring code, researching patterns, or implementing discrete features. For exploratory/read-only tasks, instruct the subagent to avoid edit_file and write_file.",
	skill:
		"Load a skill by name to get specialized instructions and workflows. Use when a task matches an available skill's description.",
};

const PARENT_TOOLS = [
	"read_file",
	"list_directory",
	"write_file",
	"edit_file",
	"grep_search",
	"bash",
	"sqlite3",
	"task",
	"skill",
];
const SUBAGENT_TOOLS = ["read_file", "list_directory", "write_file", "edit_file", "grep_search", "bash", "sqlite3", "skill"];

const SUBAGENT_NOTE = `
Note: You are running as a subagent (spawned by the \`task\` tool). The \`task\` tool is not available in this context — you cannot create nested subagents. Complete your work directly using the tools listed above.`;

function buildBasePrompt(options?: { subagent?: boolean }): string {
	const isSubagent = options?.subagent === true;
	const tools = isSubagent ? SUBAGENT_TOOLS : PARENT_TOOLS;
	const toolList = tools.map((t) => `- ${t}: ${TOOL_DESCRIPTIONS[t]}`).join("\n");
	const taskGuidance = isSubagent
		? ""
		: "\n- Use the task tool for complex multi-step work that can be delegated to a subagent.";
	const subagentNote = isSubagent ? SUBAGENT_NOTE : "";

	return `You are Bob AI, a coding assistant.

You help developers write, understand, debug, and improve code. You give clear, direct answers. When a question is ambiguous, you ask for clarification rather than guess.

You have access to the following tools:

${toolList}${subagentNote}

When working with code:
- Use grep_search to find relevant code before reading entire files.
- Read files to understand context before making changes.
- Use edit_file for modifying existing files and write_file for creating new ones.
- After making changes, run relevant tests or builds to verify correctness.${taskGuidance}
- Projects often contain context files (AGENT.md, CLAUDE.md, README.md, etc.) that describe conventions, architecture, and workflows. Context files found in the project root directory (AGENT.md, AGENTS.md, CLAUDE.md) are automatically included in this system prompt as <instructions type="project-specific"> blocks — do not re-read them. In monorepos, subdirectories may contain their own context files; read those when working in a specific subdirectory.
- README.md is not auto-injected. Read it when you need to understand a project's purpose, setup, or structure.

Context Compaction:
- Some tool outputs in this conversation may have been compacted to manage context size. Compacted outputs are marked with "# COMPACTED" followed by a short description of what was removed. If you need the full output, you can re-invoke the tool. The original data is not lost — it has been summarized for efficiency.
- Do not mention compaction to the user unless they ask about it.`;
}

export interface SystemPromptOptions {
	/** When true, builds the prompt for a subagent context (no task tool). */
	subagent?: boolean;
}

export function buildSystemPrompt(
	skills: Skill[],
	instructions: InstructionFile[] = [],
	options?: SystemPromptOptions,
): string {
	const parts: string[] = [`<base>\n${buildBasePrompt(options)}\n</base>`];

	if (skills.length > 0) {
		const listing = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
		parts.push(
			`<skills>\n## Available Skills\n\nUse the \`skill\` tool to load a skill when a task matches its description. Skills provide specialized instructions and workflows.\n\n${listing}\n</skills>`,
		);
	}

	for (const instruction of instructions) {
		const sourceAttr = instruction.type === "project-specific" ? ` source="${path.basename(instruction.source)}"` : "";
		parts.push(`<instructions type="${instruction.type}"${sourceAttr}>\n${instruction.content}\n</instructions>`);
	}

	return parts.join("\n\n");
}
