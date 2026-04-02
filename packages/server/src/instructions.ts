import fs from "node:fs";
import path from "node:path";

export interface InstructionFile {
	type: "bobai-global" | "bobai-project" | "project-specific";
	source: string;
	content: string;
}

/**
 * Load optional instruction files from three layers:
 *
 * 1. bobai-global  — ~/.config/bobai/AGENT.md (user preferences, project-agnostic)
 * 2. bobai-project — <project>/.bobai/AGENT.md (user overrides for this project)
 * 3. project-specific — <project>/AGENT.md, AGENTS.md, CLAUDE.md (project conventions)
 *
 * Returns an array of instruction files that exist and have non-empty content.
 * Files are read synchronously per-call so edits are picked up without restart.
 */
export function loadInstructions(globalConfigDir: string, projectRoot: string): InstructionFile[] {
	const candidates: { type: InstructionFile["type"]; filePath: string }[] = [
		// Layer 1 & 2: Bob AI specific instruction files
		{ type: "bobai-global", filePath: path.join(globalConfigDir, "AGENT.md") },
		{ type: "bobai-project", filePath: path.join(projectRoot, ".bobai", "AGENT.md") },
		// Layer 3: Project-root context files (shared team conventions)
		{ type: "project-specific", filePath: path.join(projectRoot, "AGENT.md") },
		{ type: "project-specific", filePath: path.join(projectRoot, "AGENTS.md") },
		{ type: "project-specific", filePath: path.join(projectRoot, "CLAUDE.md") },
	];

	const results: InstructionFile[] = [];
	for (const { type, filePath } of candidates) {
		try {
			const content = fs.readFileSync(filePath, "utf-8").trim();
			if (content.length > 0) {
				results.push({ type, source: filePath, content });
			}
		} catch {
			// File doesn't exist or isn't readable — skip silently
		}
	}
	return results;
}
