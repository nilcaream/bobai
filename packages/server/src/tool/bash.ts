import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 50_000;

export const bashTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "bash",
			description:
				"Execute a bash command in the project directory. Returns stdout, stderr, and exit code. Use for running tests, builds, linters, git commands, and other shell operations.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The bash command to execute",
					},
					timeout: {
						type: "number",
						description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
					},
				},
				required: ["command"],
			},
		},
	},

	mergeable: false,

	compactionResistance: 0.5,

	compact(output: string, strength: number, callArgs: Record<string, unknown>): string {
		const command = typeof callArgs.command === "string" ? callArgs.command : "?";
		// Don't compact error messages or very short output
		if (output.startsWith("Error")) return output;

		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 6) return output;

		// Detect and preserve trailing status (exit code, timeout notice)
		let trailer = "";
		let contentLines = lines;
		const lastLine = lines[total - 1] ?? "";

		if (lastLine.startsWith("exit code:") || lastLine.startsWith("Command timed out")) {
			trailer = `\n${lastLine}`;
			// Check for empty line before the status line
			const secondLast = total >= 2 ? (lines[total - 2] ?? "") : "";
			contentLines = secondLast === "" ? lines.slice(0, -2) : lines.slice(0, -1);
		}

		const contentTotal = contentLines.length;
		if (contentTotal <= 6) return output;

		// Tail-only strategy: keep the last N lines. For bash output the tail
		// (final status, errors, summary) is almost always more important than
		// the head (early verbose output). Cap at 10 lines — old bash output is
		// historical context; the LLM has already acted on it.
		const MAX_KEEP_LINES = 10;
		const keepCount = Math.min(MAX_KEEP_LINES, Math.max(3, Math.floor(contentTotal * (1 - strength))));
		if (keepCount >= contentTotal) return output;

		const tail = contentLines.slice(-keepCount).join("\n");
		const removed = contentTotal - keepCount;
		return `${COMPACTION_MARKER} ${removed} lines from bash('${command}') omitted\n${tail}${trailer}`;
	},

	formatCall(args: Record<string, unknown>): string {
		const command = typeof args.command === "string" ? args.command : "?";
		return `\`$ ${command}\``;
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const command = args.command;
		if (typeof command !== "string" || command.length === 0) {
			return {
				llmOutput: "Error: 'command' argument is required and must be a non-empty string",
				uiOutput: "Error: 'command' argument is required and must be a non-empty string",

				mergeable: false,
			};
		}

		const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;

		try {
			const proc = Bun.spawn(["/bin/bash", "-c", command], {
				cwd: ctx.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			let timerId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timerId = setTimeout(() => resolve("timeout"), timeoutMs);
			});
			const exitPromise = proc.exited;

			const result = await Promise.race([exitPromise.then((code) => ({ kind: "done" as const, code })), timeoutPromise]);

			if (result === "timeout") {
				proc.kill();
				const partialRead = (stream: ReadableStream<Uint8Array>) =>
					Promise.race([new Response(stream).text(), new Promise<string>((r) => setTimeout(() => r(""), 2000))]);
				const stdout = await partialRead(proc.stdout);
				const stderr = await partialRead(proc.stderr);
				let output = truncate(`${stdout}${stderr}`.trim());
				if (output.length > 0) output += "\n\n";
				output += `Command timed out after ${timeoutMs}ms`;
				return { llmOutput: output, uiOutput: formatBashOutput(command, output), mergeable: false };
			}

			if (timerId !== undefined) clearTimeout(timerId);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const combined = `${stdout}${stderr}`.trim();
			const truncated = truncate(combined);

			if (result.code !== 0) {
				return {
					llmOutput: `${truncated}\n\nexit code: ${result.code}`,
					uiOutput: formatBashOutput(command, `${truncated}\n\nexit code: ${result.code}`),

					mergeable: false,
				};
			}

			return {
				llmOutput: truncated || "(no output)",
				uiOutput: formatBashOutput(command, truncated || "(no output)"),

				mergeable: false,
			};
		} catch (err) {
			return {
				llmOutput: `Error executing command: ${(err as Error).message}`,
				uiOutput: `Error executing command: ${(err as Error).message}`,

				mergeable: false,
			};
		}
	},
};

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n... truncated (${text.length} bytes total, showing first ${MAX_OUTPUT_BYTES})`;
}

function formatBashOutput(command: string, output: string): string {
	return `\`$ ${command}\`\n\n\`\`\`\n${output}\n\`\`\``;
}
