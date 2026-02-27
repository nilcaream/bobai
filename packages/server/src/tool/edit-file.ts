import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const editFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "edit_file",
			description:
				"Edit a file by replacing a specific string with new content. The old_string must match exactly one location in the file. Include enough surrounding context in old_string to make it unique.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
					old_string: {
						type: "string",
						description: "The exact string to find and replace. Must match exactly one location in the file.",
					},
					new_string: {
						type: "string",
						description: "The string to replace old_string with",
					},
				},
				required: ["path", "old_string", "new_string"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}
		const oldString = args.old_string;
		if (typeof oldString !== "string" || oldString.length === 0) {
			return { output: "Error: 'old_string' argument is required and must be a non-empty string", isError: true };
		}
		const newString = args.new_string;
		if (typeof newString !== "string") {
			return { output: "Error: 'new_string' argument is required and must be a string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		let content: string;
		try {
			content = fs.readFileSync(resolved, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: file not found: ${filePath}`, isError: true };
			}
			return { output: `Error reading file: ${(err as Error).message}`, isError: true };
		}

		// Count occurrences
		let count = 0;
		let idx = 0;
		while ((idx = content.indexOf(oldString, idx)) !== -1) {
			count++;
			idx += oldString.length;
		}

		if (count === 0) {
			return { output: `Error: old_string not found in ${filePath}`, isError: true };
		}
		if (count > 1) {
			return {
				output: `Error: old_string found multiple times (${count}) in ${filePath}. Include more surrounding context to make the match unique.`,
				isError: true,
			};
		}

		// Perform the replacement
		const newContent = content.replace(oldString, () => newString);
		fs.writeFileSync(resolved, newContent, "utf-8");

		// Show context around the edit
		const editIdx = newContent.indexOf(newString);
		const lines = newContent.split("\n");
		let editLine = 0;
		let charCount = 0;
		for (let i = 0; i < lines.length; i++) {
			charCount += lines[i].length + 1; // +1 for newline
			if (charCount > editIdx) {
				editLine = i;
				break;
			}
		}
		const ctxStart = Math.max(0, editLine - 3);
		const ctxEnd = Math.min(lines.length, editLine + newString.split("\n").length + 3);
		const contextLines = lines.slice(ctxStart, ctxEnd).map((l, i) => `${ctxStart + i + 1}: ${l}`);

		return { output: `Edited ${filePath}:\n${contextLines.join("\n")}` };
	},
};
