import fs from "node:fs";
import path from "node:path";

export interface InstructionFile {
	type: "global" | "project";
	source: string;
	content: string;
}

/**
 * Load optional instruction files (AGENT.md) from global config and project directories.
 *
 * Returns an array of instruction files that exist and have non-empty content.
 * Files are read synchronously per-call so edits are picked up without restart.
 */
export function loadInstructions(globalConfigDir: string, projectRoot: string): InstructionFile[] {
	const candidates: { type: InstructionFile["type"]; filePath: string }[] = [
		{ type: "global", filePath: path.join(globalConfigDir, "AGENT.md") },
		{ type: "project", filePath: path.join(projectRoot, ".bobai", "AGENT.md") },
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
