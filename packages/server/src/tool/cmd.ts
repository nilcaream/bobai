import { COMPACTION_MARKER } from "../compaction/default-strategy";
import type { Tool, ToolContext, ToolResult } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32_000;

export const cmdTool: Tool = {
	definition: {
		type: "function",
		function: {
			name: "cmd",
			description:
				"Execute a Windows batch command (cmd.exe) in the project directory. Returns stdout, stderr, and exit code. The command is executed via cmd.exe /c — use && to chain multiple commands on one line, or ^ for line continuations in batch.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The batch command to execute. Can be multiline.",
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

	baseDistance: 150,

	outputThreshold: 0.4,

	compact(output: string, callArgs: Record<string, unknown>): string {
		const command = typeof callArgs.command === "string" ? callArgs.command : "?";
		if (output.startsWith("Error")) return output;
		const lines = output.split("\n");
		const total = lines.length;
		if (total <= 10) return output;
		const tail = lines.slice(-10).join("\n");
		const removed = total - 10;
		return `${COMPACTION_MARKER} ${removed} lines from cmd(${JSON.stringify({ command })}) omitted\n${tail}`;
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
			const proc = Bun.spawn(["cmd.exe", "/c", command], {
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
					uiOutput: formatOutput(command, output || "(no output)"),
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
				uiOutput: formatOutput(command, displayOutput),
				summary: formatSummary(`exit code: ${result.code}`, elapsed),
				mergeable: false,
			};
		} catch (err) {
			const msg = (err as Error).message;
			return {
				llmOutput: `Error executing command: ${msg}`,
				uiOutput: formatOutput(command, `Error: ${msg}`),
				mergeable: false,
			};
		}
	},
};

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	const kept = text.slice(-MAX_OUTPUT_BYTES);
	const totalBytes = text.length;
	return `... truncated (${totalBytes} bytes total, showing last ${MAX_OUTPUT_BYTES})\n${kept}`;
}

function formatScript(command: string): string {
	return `\`\`\`batch\n${command}\n\`\`\``;
}

function formatOutput(command: string, output: string): string {
	return `${formatScript(command)}\n\n---\n\n\`\`\`\n${output}\n\`\`\``;
}

function formatSummary(status: string, elapsedSec: number): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${ts} | ${status} | ${elapsedSec.toFixed(2)}s`;
}
