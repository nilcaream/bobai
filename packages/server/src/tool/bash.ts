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
				"Execute a bash script in the project directory. Returns stdout, stderr, and exit code. The command is executed as a script — use multiple lines freely instead of long && chains. For readability, split long commands with line continuations (\\) or separate lines.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The bash script to execute. Can be multiline — prefer separate lines over long && chains.",
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
		return formatScript(command);
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
		const startTime = performance.now();

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
				const elapsed = (performance.now() - startTime) / 1000;
				const partialRead = (stream: ReadableStream<Uint8Array>) =>
					Promise.race([new Response(stream).text(), new Promise<string>((r) => setTimeout(() => r(""), 2000))]);
				const stdout = await partialRead(proc.stdout);
				const stderr = await partialRead(proc.stderr);
				const output = truncate(`${stdout}${stderr}`.trim());
				const status = `Command timed out after ${timeoutMs}ms`;
				const llm = output.length > 0 ? `${output}\n\n${status}` : status;
				return {
					llmOutput: llm,
					uiOutput: formatBashOutput(command, output || "(no output)"),
					summary: formatSummary("timed out", elapsed),
					mergeable: false,
				};
			}

			if (timerId !== undefined) clearTimeout(timerId);
			const elapsed = (performance.now() - startTime) / 1000;
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const combined = `${stdout}${stderr}`.trim();
			const truncated = truncate(combined);
			const displayOutput = truncated || "(no output)";
			const llmOutput = truncated ? `${truncated}\n\nexit code: ${result.code}` : `(no output)\n\nexit code: ${result.code}`;

			return {
				llmOutput,
				uiOutput: formatBashOutput(command, displayOutput),
				summary: formatSummary(`exit code: ${result.code}`, elapsed),
				mergeable: false,
			};
		} catch (err) {
			const msg = (err as Error).message;
			return {
				llmOutput: `Error executing command: ${msg}`,
				uiOutput: formatBashOutput(command, `Error: ${msg}`),
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

/** Render the command as a fenced bash code block (script section). */
function formatScript(command: string): string {
	return `\`\`\`bash\n${command}\n\`\`\``;
}

/** Build the full UI output: script + horizontal rule + output. */
function formatBashOutput(command: string, output: string): string {
	return `${formatScript(command)}\n\n---\n\n\`\`\`\n${output}\n\`\`\``;
}

/** Build the summary line: "YYYY-MM-DD HH:MM:SS | exit code: N | 1.23s" */
function formatSummary(status: string, elapsedSec: number): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${ts} | ${status} | ${elapsedSec.toFixed(2)}s`;
}
