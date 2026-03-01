import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const listDirectoryTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "list_directory",
			description:
				"List the contents of a directory. The path is relative to the project root. Defaults to the project root if path is omitted.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the directory from the project root. Defaults to '.' (project root).",
					},
				},
				required: [],
			},
		},
	},

	mergeable: true,

	formatCall(args: Record<string, unknown>): string {
		const dir = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		return `▸ Listing ${dir}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";

		const resolved = path.resolve(ctx.projectRoot, dirPath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return {
				llmOutput: `Error: path '${dirPath}' resolves outside the project root`,
				uiOutput: `Error: path '${dirPath}' resolves outside the project root`,
				isError: true,
				mergeable: true,
			};
		}

		try {
			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			return {
				llmOutput: lines.join("\n"),
				uiOutput: `▸ Listing ${dirPath} (${entries.length} entries)`,
				isError: false,
				mergeable: true,
			};
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					llmOutput: `Error: directory not found: ${dirPath}`,
					uiOutput: `▸ Listing ${dirPath} — not found`,
					isError: true,
					mergeable: true,
				};
			}
			if (code === "ENOTDIR") {
				return {
					llmOutput: `Error: '${dirPath}' is not a directory`,
					uiOutput: `▸ Listing ${dirPath} — not a directory`,
					isError: true,
					mergeable: true,
				};
			}
			return {
				llmOutput: `Error listing directory: ${(err as Error).message}`,
				uiOutput: `Error listing directory: ${(err as Error).message}`,
				isError: true,
				mergeable: true,
			};
		}
	},
};
