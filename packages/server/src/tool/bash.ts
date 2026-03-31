import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32_000;

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

	outputThreshold: 0.4,

	compact(output: string, callArgs: Record<string, unknown>): string {
		const command = typeof callArgs.command === "string" ? callArgs.command : "?";
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 10) return output;
		const tail = lines.slice(-10).join("\n");
		const removed = total - 10;
		return `${COMPACTION_MARKER} ${removed} lines from bash(${JSON.stringify({ command })}) omitted\n${tail}`;
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
				const output = truncate(`${stdout}${stderr}`.trim());
				const status = `Command timed out after ${timeoutMs}ms`;
				const llm = output.length > 0 ? `${output}\n\n${status}` : status;
				return { llmOutput: llm, uiOutput: formatBashOutput(command, llm), mergeable: false };
			}

			if (timerId !== undefined) clearTimeout(timerId);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const combined = `${stdout}${stderr}`.trim();
			const truncated = truncate(combined);
			const output = truncated ? `${truncated}\n\nexit code: ${result.code}` : `(no output)\n\nexit code: ${result.code}`;

			return {
				llmOutput: output,
				uiOutput: formatBashOutput(command, output),
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

/** Truncate output keeping the tail (most recent/relevant output). */
function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	const kept = text.slice(-MAX_OUTPUT_BYTES);
	const totalBytes = text.length;
	return `... truncated (${totalBytes} bytes total, showing last ${MAX_OUTPUT_BYTES})\n${kept}`;
}

function formatBashOutput(command: string, output: string): string {
	return `\`$ ${command}\`\n\n\`\`\`\n${output}\n\`\`\``;
}
