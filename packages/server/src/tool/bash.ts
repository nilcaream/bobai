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
						description: "Timeout in milliseconds. Defaults to 30000 (30 seconds).",
					},
				},
				required: ["command"],
			},
		},
	},

	async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const command = args.command;
		if (typeof command !== "string" || command.length === 0) {
			return { output: "Error: 'command' argument is required and must be a non-empty string", isError: true };
		}

		const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;

		try {
			const proc = Bun.spawn(["/bin/bash", "-c", command], {
				cwd: ctx.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			let timerId: ReturnType<typeof setTimeout>;
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
				return { output, isError: true };
			}

			clearTimeout(timerId!);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const combined = `${stdout}${stderr}`.trim();
			const truncated = truncate(combined);

			if (result.code !== 0) {
				return {
					output: `${truncated}\n\nexit code: ${result.code}`,
					isError: true,
				};
			}

			return { output: truncated || "(no output)" };
		} catch (err) {
			return { output: `Error executing command: ${(err as Error).message}`, isError: true };
		}
	},
};

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n... truncated (${text.length} bytes total, showing first ${MAX_OUTPUT_BYTES})`;
}
