import fs from "node:fs";
import path from "node:path";
import { COMPACTION_MARKER } from "../compaction/default-strategy";
import { FileTime } from "../file/time";
import type { Tool, ToolContext, ToolResult } from "./tool";
import { escapeMarkdown, isPathAccessible } from "./tool";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

export const readFileTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "read_file",
			description: `Read the contents of a file. The path is relative to the project root. By default returns up to ${MAX_LINE_LENGTH} lines from the start of the file. Each line is prefixed with its line number. Use 'from' and 'to' to read a specific range of lines. Use the grep_search tool to find specific content in large files.`,
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
						description: `Line number to stop reading at (inclusive). Defaults to from + ${MAX_LINE_LENGTH - 1}.`,
					},
				},
				required: ["path"],
			},
		},
	},

	mergeable: true,

	outputThreshold: 0.3,

	compact(output: string, callArgs: Record<string, unknown>): string {
		if (output.startsWith("Error:")) return output;
		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 6) return output;
		const head = lines.slice(0, 3).join("\n");
		const tail = lines.slice(-3).join("\n");
		const removed = total - 6;
		const markerArgs: Record<string, unknown> = { path: callArgs.path };
		if (callArgs.from !== undefined) markerArgs.from = callArgs.from;
		if (callArgs.to !== undefined) markerArgs.to = callArgs.to;
		return `${head}\n${COMPACTION_MARKER} ${removed} lines from read_file(${JSON.stringify(markerArgs)}) omitted. Re-read to see full content.\n${tail}`;
	},

	formatCall(args: Record<string, unknown>): string {
		const filePath = typeof args.path === "string" ? args.path : "?";
		const from = typeof args.from === "number" ? args.from : undefined;
		const to = typeof args.to === "number" ? args.to : undefined;
		const range = from || to ? ` (lines ${from ?? 1}-${to ?? "end"})` : "";
		return `▸ Reading ${escapeMarkdown(filePath)}${range}`;
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

		const resolved = path.resolve(ctx.projectRoot, filePath);
		if (!isPathAccessible(resolved, ctx)) {
			return {
				llmOutput: `Error: path '${filePath}' resolves outside the project root`,
				uiOutput: `Error: path '${filePath}' resolves outside the project root`,

				mergeable: true,
			};
		}

		let rawContent: string;
		try {
			rawContent = fs.readFileSync(resolved, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					llmOutput: `Error: file not found: ${filePath}`,
					uiOutput: `▸ Reading ${escapeMarkdown(filePath)} — file not found`,

					mergeable: true,
				};
			}
			if (code === "EISDIR") {
				return {
					llmOutput: `Error: '${filePath}' is a directory, not a file. Use list_directory instead.`,
					uiOutput: `▸ Reading ${escapeMarkdown(filePath)} — is a directory`,

					mergeable: true,
				};
			}
			return {
				llmOutput: `Error reading file: ${(err as Error).message}`,
				uiOutput: `Error reading file: ${(err as Error).message}`,

				mergeable: true,
			};
		}

		const allLines = rawContent.split("\n");
		const totalLines = allLines.length;

		const from = typeof args.from === "number" && args.from >= 1 ? Math.floor(args.from) : 1;
		const defaultTo = from + DEFAULT_LINE_LIMIT - 1;
		const to = typeof args.to === "number" && args.to >= from ? Math.floor(args.to) : defaultTo;

		if (from > totalLines) {
			return {
				llmOutput: `Error: 'from' (${from}) is beyond end of file (${totalLines} lines)`,
				uiOutput: `Error: 'from' (${from}) is beyond end of file (${totalLines} lines)`,

				mergeable: true,
			};
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
			footer = `(Output capped at ${MAX_BYTES} bytes. Showing lines ${from}-${lastLine}. Use from=${lastLine + 1} to continue.)`;
		} else if (hasMore) {
			footer = `(Showing lines ${from}-${lastLine} of ${totalLines}. Use from=${lastLine + 1} to continue.)`;
		} else {
			footer = `(End of file - total ${totalLines} lines)`;
		}

		FileTime.read(ctx.sessionId, resolved);

		return {
			llmOutput: `${outputLines.join("\n")}\n\n${footer}`,
			uiOutput: `▸ Reading ${escapeMarkdown(filePath)} (${outputLines.length} lines)`,

			mergeable: true,
		};
	},
};
