import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown, isPathAccessible } from "./tool";

const MAX_RESULTS = 100;

export const grepSearchTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "grep_search",
			description:
				"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Searches recursively from the given path (defaults to project root).",
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "The search pattern (regular expression or fixed string)",
					},
					path: {
						type: "string",
						description: "Relative path to search from. Defaults to project root.",
					},
					include: {
						type: "string",
						description: "File glob pattern to filter which files are searched (e.g. '*.ts', '*.{ts,tsx}')",
					},
				},
				required: ["pattern"],
			},
		},
	},

	mergeable: true,

	compactionResistance: 0.2,

	compact(output: string, strength: number, callArgs: Record<string, unknown>): string {
		const pattern = typeof callArgs.pattern === "string" ? callArgs.pattern : "?";
		// Don't compact error/empty results
		if (output === "No matches found." || output.startsWith("Error")) return output;

		const lines = output.split("\n");
		// Strip any existing truncation notice
		const matchLines = lines.filter((l) => !l.startsWith("... truncated"));
		const total = matchLines.length;
		if (total <= 3) return output;

		const keepCount = Math.max(3, Math.floor(total * (1 - strength)));
		if (keepCount >= total) return output;

		const kept = matchLines.slice(0, keepCount).join("\n");
		return `${kept}\n${COMPACTION_MARKER} grep_search('${pattern}') found ${total} matches, showing first ${keepCount}. Re-run to see all.`;
	},

	formatCall(args: Record<string, unknown>): string {
		const pattern = typeof args.pattern === "string" ? args.pattern : "?";
		const dir = typeof args.path === "string" ? args.path : ".";
		return `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(dir)}`;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const pattern = args.pattern;
		if (typeof pattern !== "string" || pattern.length === 0) {
			return {
				llmOutput: "Error: 'pattern' argument is required and must be a non-empty string",
				uiOutput: "Error: 'pattern' argument is required and must be a non-empty string",

				mergeable: true,
			};
		}

		const searchPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
		const resolved = path.resolve(ctx.projectRoot, searchPath);
		if (!isPathAccessible(resolved, ctx)) {
			return {
				llmOutput: `Error: path '${searchPath}' resolves outside the project root`,
				uiOutput: `Error: path '${searchPath}' resolves outside the project root`,

				mergeable: true,
			};
		}

		const grepArgs = ["-rn", "--color=never"];
		if (typeof args.include === "string" && args.include.length > 0) {
			grepArgs.push(`--include=${args.include}`);
		}
		grepArgs.push("--", pattern, ".");

		try {
			const proc = Bun.spawn(["grep", ...grepArgs], {
				cwd: resolved,
				stdout: "pipe",
				stderr: "pipe",
			});

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode === 1 && stdout.length === 0) {
				return {
					llmOutput: "No matches found.",
					uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (no results)`,

					mergeable: true,
				};
			}
			if (exitCode > 1) {
				return {
					llmOutput: `Error running grep: ${stderr}`,
					uiOutput: `Error running grep: ${stderr}`,

					mergeable: true,
				};
			}

			const lines = stdout.trimEnd().split("\n");
			if (lines.length > MAX_RESULTS) {
				return {
					llmOutput: `${lines.slice(0, MAX_RESULTS).join("\n")}\n\n... truncated (${lines.length} total matches, showing first ${MAX_RESULTS})`,
					uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (${lines.length} results)`,

					mergeable: true,
				};
			}
			return {
				llmOutput: stdout.trimEnd(),
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (${lines.length} results)`,

				mergeable: true,
			};
		} catch (err) {
			return {
				llmOutput: `Error running search: ${(err as Error).message}`,
				uiOutput: `Error running search: ${(err as Error).message}`,

				mergeable: true,
			};
		}
	},
};
