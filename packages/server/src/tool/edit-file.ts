import fs from "node:fs";
import path from "node:path";
import { diffLines } from "diff";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { FileTime } from "../file/time";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

export const editFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "edit_file",
			description:
				"Edit a file by replacing a specific string with new content. The old_string must match exactly one location in the file. Include enough surrounding context in old_string to make it unique. Use actual newline characters in string values, never escaped sequences like \\n.",
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

	mergeable: false,

	maxDistance: 150,

	outputThreshold: 0.55,

	argsThreshold: 0.35,

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 6) return output;
		const head = lines.slice(0, 3).join("\n");
		const tail = lines.slice(-3).join("\n");
		const removed = total - 6;
		return `${head}\n${COMPACTION_MARKER} ${removed} lines from edit_file(${JSON.stringify({ path: callArgs.path })}) output omitted. Re-read the file to see current content.\n${tail}`;
	},

	compactArgs(args: Record<string, unknown>): Record<string, unknown> {
		const result = { ...args };
		if (typeof result.old_string === "string") result.old_string = COMPACTION_MARKER;
		if (typeof result.new_string === "string") result.new_string = COMPACTION_MARKER;
		return result;
	},

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		const oldString = typeof args.old_string === "string" ? args.old_string : "";
		const newString = typeof args.new_string === "string" ? args.new_string : "";
		const diffLines_: string[] = [];
		for (const change of diffLines(oldString, newString)) {
			const lines = change.value.replace(/\n$/, "").split("\n");
			const prefix = change.added ? "+" : change.removed ? "-" : " ";
			for (const line of lines) {
				diffLines_.push(`${prefix} ${line}`);
			}
		}
		return `▸ Editing ${escapeMarkdown(filePath)}\n\n\`\`\`diff\n${diffLines_.join("\n")}\n\`\`\``;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return {
				llmOutput: "Error: 'path' argument is required and must be a non-empty string",
				uiOutput: "Error: 'path' argument is required and must be a non-empty string",

				mergeable: false,
			};
		}
		const oldString = args.old_string;
		if (typeof oldString !== "string" || oldString.length === 0) {
			return {
				llmOutput: "Error: 'old_string' argument is required and must be a non-empty string",
				uiOutput: "Error: 'old_string' argument is required and must be a non-empty string",

				mergeable: false,
			};
		}
		const newString = args.new_string;
		if (typeof newString !== "string") {
			return {
				llmOutput: "Error: 'new_string' argument is required and must be a string",
				uiOutput: "Error: 'new_string' argument is required and must be a string",

				mergeable: false,
			};
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return {
				llmOutput: `Error: path '${filePath}' resolves outside the project root`,
				uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — outside project root`,

				mergeable: false,
			};
		}

		try {
			FileTime.assert(ctx.sessionId, resolved);
		} catch (err) {
			return {
				llmOutput: `Error: ${(err as Error).message}`,
				uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — stale read`,
				mergeable: false,
			};
		}

		let content: string;
		try {
			content = fs.readFileSync(resolved, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					llmOutput: `Error: file not found: ${filePath}`,
					uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — file not found`,

					mergeable: false,
				};
			}
			return {
				llmOutput: `Error reading file: ${(err as Error).message}`,
				uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — error: ${(err as Error).message}`,

				mergeable: false,
			};
		}

		// Count occurrences
		let count = 0;
		let idx = content.indexOf(oldString, 0);
		while (idx !== -1) {
			count++;
			idx = content.indexOf(oldString, idx + oldString.length);
		}

		if (count === 0) {
			return {
				llmOutput: `Error: old_string not found in ${filePath}`,
				uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — old_string not found`,

				mergeable: false,
			};
		}
		if (count > 1) {
			return {
				llmOutput: `Error: old_string found multiple times (${count}) in ${filePath}. Include more surrounding context to make the match unique.`,
				uiOutput: `▸ Editing ${escapeMarkdown(filePath)} — multiple matches`,

				mergeable: false,
			};
		}

		// Perform the replacement
		const newContent = content.replace(oldString, () => newString);
		fs.writeFileSync(resolved, newContent, "utf-8");
		FileTime.read(ctx.sessionId, resolved);

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

		return { llmOutput: `Edited ${filePath}:\n${contextLines.join("\n")}`, uiOutput: null, mergeable: false };
	},
};
