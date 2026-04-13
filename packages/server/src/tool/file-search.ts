import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown, isPathAccessible } from "./tool";

const MAX_RESULTS = 1000;

export const fileSearchTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "file_search",
			description:
				"Search for files by name pattern using glob syntax. Returns file paths matching the pattern. " +
				"Use '**/' prefix for recursive search (e.g. '**/*.ts' finds all TypeScript files). " +
				"The path parameter narrows the search to a subdirectory. " +
				"Case sensitivity follows the filesystem (case-sensitive on Linux, case-insensitive on macOS).",
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "Glob pattern to match file names (e.g. '**/*.ts', 'src/**/test_*.py', '**/*.{json,yaml}')",
					},
					path: {
						type: "string",
						description: "Directory to search within, relative to the project root. Defaults to '.' (project root).",
					},
				},
				required: ["pattern"],
			},
		},
	},

	mergeable: true,

	maxDistance: 100,

	outputThreshold: 0.27,

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output.startsWith("Error:") || output.startsWith("No files found")) return output;
		const lines = output.split("\n");
		const filePaths = lines.filter((l) => !l.startsWith("(Results capped"));
		const total = filePaths.length;
		if (total <= 5) return output;
		const kept = filePaths.slice(0, 5).join("\n");
		const markerArgs: Record<string, unknown> = { pattern: callArgs.pattern };
		if (callArgs.path !== undefined) markerArgs.path = callArgs.path;
		return `${kept}\n${COMPACTION_MARKER} file_search(${JSON.stringify(markerArgs)}) found ${total} files, showing first 5. Re-run to see all.`;
	},

	formatCall(args: Record<string, unknown>): string {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		return `▸ Searching ${escapeMarkdown(pattern)}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		if (pattern.length === 0) {
			return {
				llmOutput: "Error: 'pattern' argument is required and must be a non-empty string",
				uiOutput: "Error: 'pattern' argument is required and must be a non-empty string",
				mergeable: true,
			};
		}

		const dirPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		const resolved = path.resolve(ctx.projectRoot, dirPath);

		if (!isPathAccessible(resolved, ctx)) {
			return {
				llmOutput: `Error: path '${dirPath}' resolves outside the project root`,
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(dirPath)} — outside project root`,
				mergeable: true,
			};
		}

		// Validate the directory exists and is actually a directory
		try {
			const stat = fs.statSync(resolved);
			if (!stat.isDirectory()) {
				return {
					llmOutput: `Error: '${dirPath}' is not a directory`,
					uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(dirPath)} — not a directory`,
					mergeable: true,
				};
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					llmOutput: `Error: directory not found: ${dirPath}`,
					uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(dirPath)} — directory not found`,
					mergeable: true,
				};
			}
			return {
				llmOutput: `Error: ${(err as Error).message}`,
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(dirPath)} — error: ${(err as Error).message}`,
				mergeable: true,
			};
		}

		// Use Bun.Glob to scan for matching files
		const glob = new Bun.Glob(pattern);
		const files: string[] = [];
		let capped = false;

		for await (const file of glob.scan({ cwd: resolved, onlyFiles: true, followSymlinks: true })) {
			if (files.length >= MAX_RESULTS) {
				capped = true;
				break;
			}
			files.push(file);
		}

		if (files.length === 0) {
			return {
				llmOutput: `No files found matching pattern "${pattern}" in ${dirPath}.`,
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} (0 files found)`,
				mergeable: true,
			};
		}

		let llmOutput = files.join("\n");
		if (capped) {
			llmOutput += "\n(Results capped at 1000. Narrow your pattern.)";
		}

		return {
			llmOutput,
			uiOutput: `▸ Searching ${escapeMarkdown(pattern)} (${files.length} files found)`,
			mergeable: true,
		};
	},
};
