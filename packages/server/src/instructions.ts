import fs from "node:fs";
import path from "node:path";

export interface InstructionFile {
	type: "bobai-global" | "bobai-project" | "project-specific";
	source: string;
	content: string;
}

const INSTRUCTION_FILENAMES = ["AGENT.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * Load instruction files from a single directory (one "layer").
 * Checks AGENT.md, AGENTS.md, CLAUDE.md in that order, skipping empty or missing files.
 * Combines all found files into a single InstructionFile with content joined by double newlines.
 * Returns null when no files are found in that directory.
 */
function loadLayer(dir: string, type: InstructionFile["type"]): InstructionFile | null {
	const contents: string[] = [];
	const sources: string[] = [];

	for (const filename of INSTRUCTION_FILENAMES) {
		const filePath = path.join(dir, filename);
		try {
			const content = fs.readFileSync(filePath, "utf-8").trim();
			if (content.length > 0) {
				contents.push(content);
				sources.push(filename);
			}
		} catch {
			// File doesn't exist or isn't readable — skip silently
		}
	}

	if (contents.length === 0) return null;

	return {
		type,
		source: sources.join(", "),
		content: contents.join("\n\n"),
	};
}

/**
 * Load optional instruction files from three layers:
 *
 * 1. bobai-global  — ~/.config/bobai/{AGENT,AGENTS,CLAUDE}.md (user preferences)
 * 2. bobai-project — <project>/.bobai/{AGENT,AGENTS,CLAUDE}.md (user overrides)
 * 3. project-specific — <project>/{AGENT,AGENTS,CLAUDE}.md (project conventions)
 *
 * Within each layer, files are combined in order: AGENT.md, AGENTS.md, CLAUDE.md.
 * Returns at most one entry per layer. Files are read synchronously per-call
 * so edits are picked up without restart.
 */
export function loadInstructions(globalConfigDir: string, projectRoot: string): InstructionFile[] {
	const results: InstructionFile[] = [];

	const globalEntry = loadLayer(globalConfigDir, "bobai-global");
	if (globalEntry) results.push(globalEntry);

	const projectEntry = loadLayer(path.join(projectRoot, ".bobai"), "bobai-project");
	if (projectEntry) results.push(projectEntry);

	const rootEntry = loadLayer(projectRoot, "project-specific");
	if (rootEntry) results.push(rootEntry);

	return results;
}
