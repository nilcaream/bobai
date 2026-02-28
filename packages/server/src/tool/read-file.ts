import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tool";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

export const readFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "read_file",
			description:
				"Read the contents of a file. The path is relative to the project root. By default returns up to 2000 lines from the start of the file. Each line is prefixed with its line number. Use 'from' and 'to' to read a specific range of lines. Use the grep_search tool to find specific content in large files.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the file from the project root",
					},
					from: {
						type: "number",
						description: "Line number to start reading from (1-indexed, inclusive). Defaults to 1.",
					},
					to: {
						type: "number",
						description: "Line number to stop reading at (inclusive). Defaults to from + 1999.",
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

		let rawContent: string;
		try {
			rawContent = fs.readFileSync(resolved, "utf-8");
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

		const allLines = rawContent.split("\n");
		const totalLines = allLines.length;

		const from = typeof args.from === "number" && args.from >= 1 ? Math.floor(args.from) : 1;
		const defaultTo = from + DEFAULT_LINE_LIMIT - 1;
		const to = typeof args.to === "number" && args.to >= from ? Math.floor(args.to) : defaultTo;

		if (from > totalLines) {
			return { output: `Error: 'from' (${from}) is beyond end of file (${totalLines} lines)`, isError: true };
		}

		const startIdx = from - 1;
		const endIdx = Math.min(to, totalLines);
		const sliced = allLines.slice(startIdx, endIdx);

		// Apply per-line truncation and byte budget
		const outputLines: string[] = [];
		let bytes = 0;
		let truncatedByBytes = false;

		for (let i = 0; i < sliced.length; i++) {
			let line = sliced[i];
			if (line.length > MAX_LINE_LENGTH) {
				line = `${line.substring(0, MAX_LINE_LENGTH)}... (truncated)`;
			}
			const lineNum = from + i;
			const formatted = `${lineNum}: ${line}`;
			const size = Buffer.byteLength(formatted, "utf-8") + (outputLines.length > 0 ? 1 : 0);

			if (bytes + size > MAX_BYTES) {
				truncatedByBytes = true;
				break;
			}

			outputLines.push(formatted);
			bytes += size;
		}

		const lastLine = from + outputLines.length - 1;
		const hasMore = lastLine < totalLines;

		let footer: string;
		if (truncatedByBytes) {
			footer = `(Output capped at 50 KB. Showing lines ${from}-${lastLine}. Use from=${lastLine + 1} to continue.)`;
		} else if (hasMore) {
			footer = `(Showing lines ${from}-${lastLine} of ${totalLines}. Use from=${lastLine + 1} to continue.)`;
		} else {
			footer = `(End of file - total ${totalLines} lines)`;
		}

		return { output: `${outputLines.join("\n")}\n\n${footer}` };
	},
};
