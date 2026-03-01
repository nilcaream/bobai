import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

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

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		return `▸ Writing ${filePath}`;
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
				uiOutput: `Error: path '${filePath}' resolves outside the project root`,

				mergeable: true,
			};
		}

		try {
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, content, "utf-8");
			return {
				llmOutput: `Wrote ${content.length} bytes to ${filePath}`,
				uiOutput: `▸ Writing ${filePath} (${content.length} bytes)`,

				mergeable: true,
			};
		} catch (err) {
			return {
				llmOutput: `Error writing file: ${(err as Error).message}`,
				uiOutput: `Error writing file: ${(err as Error).message}`,

				mergeable: true,
			};
		}
	},
};
