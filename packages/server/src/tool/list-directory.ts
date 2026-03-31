import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown, isPathAccessible } from "./tool";

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

	outputThreshold: 0.2,

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 5) return output;
		const kept = lines.slice(0, 5).join("\n");
		return `${kept}\n${COMPACTION_MARKER} list_directory(${JSON.stringify({ path: callArgs.path ?? "." })}) showed ${total} entries, showing first 5. Re-run to see all.`;
	},

	formatCall(args: Record<string, unknown>): string {
		const dir = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		return `▸ Listing ${escapeMarkdown(dir)}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";

		const resolved = path.resolve(ctx.projectRoot, dirPath);
		if (!isPathAccessible(resolved, ctx)) {
			return {
				llmOutput: `Error: path '${dirPath}' resolves outside the project root`,
				uiOutput: `Error: path '${dirPath}' resolves outside the project root`,

				mergeable: true,
			};
		}

		try {
			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			return {
				llmOutput: lines.join("\n"),
				uiOutput: `▸ Listing ${escapeMarkdown(dirPath)} (${entries.length} entries)`,

				mergeable: true,
			};
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					llmOutput: `Error: directory not found: ${dirPath}`,
					uiOutput: `▸ Listing ${escapeMarkdown(dirPath)} — not found`,

					mergeable: true,
				};
			}
			if (code === "ENOTDIR") {
				return {
					llmOutput: `Error: '${dirPath}' is not a directory`,
					uiOutput: `▸ Listing ${escapeMarkdown(dirPath)} — not a directory`,

					mergeable: true,
				};
			}
			return {
				llmOutput: `Error listing directory: ${(err as Error).message}`,
				uiOutput: `Error listing directory: ${(err as Error).message}`,

				mergeable: true,
			};
		}
	},
};
