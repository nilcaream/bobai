import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { FileTime } from "../file/time";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown } from "./tool";

export const writeFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "write_file",
			description:
				"Create or overwrite a file. The path is relative to the project root. Parent directories are created automatically. Use actual newline characters in content, never escaped sequences like \\n.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
					content: {
						type: "string",
						description: "The content to write to the file",
					},
				},
				required: ["path", "content"],
			},
		},
	},

	mergeable: true,

	argsThreshold: 0.6,

	compactArgs(args: Record<string, unknown>): Record<string, unknown> {
		const result = { ...args };
		if (typeof result.content === "string") {
			result.content = COMPACTION_MARKER;
		}
		return result;
	},

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		return `▸ Writing ${escapeMarkdown(filePath)}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return {
				llmOutput: "Error: 'path' argument is required and must be a non-empty string",
				uiOutput: "Error: 'path' argument is required and must be a non-empty string",

				mergeable: true,
			};
		}
		const content = args.content;
		if (typeof content !== "string") {
			return {
				llmOutput: "Error: 'content' argument is required and must be a string",
				uiOutput: "Error: 'content' argument is required and must be a string",

				mergeable: true,
			};
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return {
				llmOutput: `Error: path '${filePath}' resolves outside the project root`,
				uiOutput: `▸ Writing ${escapeMarkdown(filePath)} — outside project root`,

				mergeable: true,
			};
		}

		// Only assert if the file already exists (overwrite)
		if (fs.existsSync(resolved)) {
			try {
				FileTime.assert(ctx.sessionId, resolved);
			} catch (err) {
				return {
					llmOutput: `Error: ${(err as Error).message}`,
					uiOutput: `▸ Writing ${escapeMarkdown(filePath)} — stale read`,
					mergeable: true,
				};
			}
		}

		try {
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, content, "utf-8");
			FileTime.read(ctx.sessionId, resolved);
			return {
				llmOutput: `Wrote ${content.length} bytes to ${filePath}`,
				uiOutput: `▸ Writing ${escapeMarkdown(filePath)} (${content.length} bytes)`,

				mergeable: true,
			};
		} catch (err) {
			return {
				llmOutput: `Error writing file: ${(err as Error).message}`,
				uiOutput: `▸ Writing ${escapeMarkdown(filePath)} — error: ${(err as Error).message}`,

				mergeable: true,
			};
		}
	},
};
