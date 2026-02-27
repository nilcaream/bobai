import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const readFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "read_file",
			description: "Read the contents of a file. The path is relative to the project root.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
				},
				required: ["path"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		try {
			const content = fs.readFileSync(resolved, "utf-8");
			return { output: content };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return { output: `Error: file not found: ${filePath}`, isError: true };
			}
			if (code === "EISDIR") {
				return { output: `Error: '${filePath}' is a directory, not a file. Use list_directory instead.`, isError: true };
			}
			return { output: `Error reading file: ${(err as Error).message}`, isError: true };
		}
	},
};
