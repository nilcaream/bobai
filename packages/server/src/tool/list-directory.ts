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

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";

		const resolved = path.resolve(ctx.projectRoot, dirPath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${dirPath}' resolves outside the project root`, isError: true };
		}

		try {
			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			return { output: lines.join("\n") };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: directory not found: ${dirPath}`, isError: true };
			}
			if (code === "ENOTDIR") {
				return { output: `Error: '${dirPath}' is not a directory`, isError: true };
			}
			return { output: `Error listing directory: ${(err as Error).message}`, isError: true };
		}
	},
};
