import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

export const writeFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "write_file",
			description:
				"Create or overwrite a file. The path is relative to the project root. Parent directories are created automatically.",
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

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const filePath = args.path;
		if (typeof filePath !== "string" || filePath.length === 0) {
			return { output: "Error: 'path' argument is required and must be a non-empty string", isError: true };
		}
		const content = args.content;
		if (typeof content !== "string") {
			return { output: "Error: 'content' argument is required and must be a string", isError: true };
		}

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!resolved.startsWith(ctx.projectRoot + path.sep) && resolved !== ctx.projectRoot) {
			return { output: `Error: path '${filePath}' resolves outside the project root`, isError: true };
		}

		try {
			fs.mkdirSync(path.dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, content, "utf-8");
			return { output: `Wrote ${content.length} bytes to ${filePath}` };
		} catch (err) {
			return { output: `Error writing file: ${(err as Error).message}`, isError: true };
		}
	},
};
