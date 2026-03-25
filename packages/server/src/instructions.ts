import fs from "node:fs";
import path from "node:path";

export interface InstructionFile {
	label: string;
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
	const candidates: { label: string; filePath: string }[] = [
		{ label: "Global Instructions", filePath: path.join(globalConfigDir, "AGENT.md") },
		{ label: "Project Instructions", filePath: path.join(projectRoot, ".bobai", "AGENT.md") },
	];

	const results: InstructionFile[] = [];
	for (const { label, filePath } of candidates) {
		try {
			const content = fs.readFileSync(filePath, "utf-8").trim();
			if (content.length > 0) {
				results.push({ label, source: filePath, content });
			}
		} catch {
			// File doesn't exist or isn't readable — skip silently
		}
	}
	return results;
}
