import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown, isPathAccessible } from "./tool";

const MAX_RESULTS = 100;
const MAX_LINE_LENGTH = 500;
const MAX_OUTPUT_CHARS = 20_000;

export const grepSearchTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "grep_search",
			description:
				"Search file contents using extended regular expressions (ERE). Returns matching lines with file paths and line numbers. Searches recursively from the given path (defaults to project root). Path can be a file to search within that single file.",
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

	outputThreshold: 0.29,

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output === "No matches found." || output.startsWith("Error")) return output;
		const lines = output.split("\n");
		const matchLines = lines.filter((l) => !l.startsWith("... truncated"));
		const total = matchLines.length;
		if (total <= 5) return output;
		const kept = matchLines.slice(0, 5).join("\n");
		const markerArgs: Record<string, unknown> = { pattern: callArgs.pattern };
		if (callArgs.path !== undefined) markerArgs.path = callArgs.path;
		if (callArgs.include !== undefined) markerArgs.include = callArgs.include;
		return `${kept}\n${COMPACTION_MARKER} grep_search(${JSON.stringify(markerArgs)}) found ${total} matches, showing first 5. Re-run to see all.`;
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

		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(resolved);
		} catch {
			// path does not exist — let grep handle it (will report "No matches")
		}
		const isFile = stat !== undefined && !stat.isDirectory();

		let grepArgs: string[];
		let cwd: string;
		if (isFile) {
			// Single-file search: no -r, search the file by name from its parent dir
			grepArgs = ["-n", "-E", "--color=never", "--", pattern, path.basename(resolved)];
			cwd = path.dirname(resolved);
		} else {
			// Directory search: recursive
			grepArgs = ["-rn", "-E", "--color=never"];
			if (typeof args.include === "string" && args.include.length > 0) {
				grepArgs.push(`--include=${args.include}`);
			}
			grepArgs.push("--", pattern, ".");
			cwd = resolved;
		}

		try {
			const proc = Bun.spawn(["grep", ...grepArgs], {
				cwd,
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
				const brief = stderr.trim().split("\n")[0] || "unknown error";
				return {
					llmOutput: `Error running grep: ${brief}`,
					uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (error: ${escapeMarkdown(brief)})`,

					mergeable: true,
				};
			}

			const lines = stdout.trimEnd().split("\n");
			const totalMatches = lines.length;

			// Truncate individual long lines
			const trimmedLines = lines.map((line) =>
				line.length > MAX_LINE_LENGTH ? `${line.substring(0, MAX_LINE_LENGTH)}... (truncated)` : line,
			);

			// Apply line-count limit
			const capped = totalMatches > MAX_RESULTS ? trimmedLines.slice(0, MAX_RESULTS) : trimmedLines;

			// Apply total output character limit
			const outputLines: string[] = [];
			let charCount = 0;
			let hitCharLimit = false;
			for (const line of capped) {
				const added = charCount > 0 ? line.length + 1 : line.length; // +1 for newline
				if (charCount + added > MAX_OUTPUT_CHARS) {
					hitCharLimit = true;
					break;
				}
				outputLines.push(line);
				charCount += added;
			}

			let llmOutput = outputLines.join("\n");
			if (hitCharLimit) {
				llmOutput += `\n\n... truncated (output limit: showing ${outputLines.length} of ${totalMatches} matches, output capped at ${MAX_OUTPUT_CHARS} characters)`;
			} else if (totalMatches > MAX_RESULTS) {
				llmOutput += `\n\n... truncated (${totalMatches} total matches, showing first ${MAX_RESULTS})`;
			}

			return {
				llmOutput,
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (${totalMatches} results)`,

				mergeable: true,
			};
		} catch (err) {
			const msg = (err as Error).message;
			return {
				llmOutput: `Error running search: ${msg}`,
				uiOutput: `▸ Searching ${escapeMarkdown(pattern)} in ${escapeMarkdown(searchPath)} (error: ${escapeMarkdown(msg)})`,

				mergeable: true,
			};
		}
	},
};
