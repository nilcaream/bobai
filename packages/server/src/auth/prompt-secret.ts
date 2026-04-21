export function createSecretPromptController(): { onData(chunk: string): string | undefined } {
	let value = "";

	return {
		onData(chunk: string): string | undefined {
			if (chunk === "\u0003") {
				throw new Error("Prompt cancelled");
			}
			if (chunk === "\r" || chunk === "\n") {
				return value;
			}
			if (chunk === "\u007f" || chunk === "\b") {
				value = value.slice(0, -1);
				return undefined;
			}
			value += chunk;
			return undefined;
		},
	};
}

export async function promptSecret(prompt: string): Promise<string> {
	process.stdout.write(prompt);

	const controller = createSecretPromptController();
	const stdin = process.stdin;
	const wasRaw = Boolean((stdin as NodeJS.ReadStream).isRaw);

	return new Promise<string>((resolve, reject) => {
		function cleanup() {
			stdin.off("data", onData);
			stdin.off("error", onError);
			if (!wasRaw && stdin.isTTY) stdin.setRawMode?.(false);
			stdin.pause();
			process.stdout.write("\n");
		}

		function onError(err: Error) {
			cleanup();
			reject(err);
		}

		function onData(chunk: Buffer | string) {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			try {
				for (const char of text) {
					const result = controller.onData(char);
					if (result !== undefined) {
						cleanup();
						resolve(result.trim());
						return;
					}
				}
			} catch (err) {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}

		try {
			if (!wasRaw && stdin.isTTY) stdin.setRawMode?.(true);
			stdin.resume();
			stdin.setEncoding("utf8");
			stdin.on("data", onData);
			stdin.on("error", onError);
		} catch (err) {
			cleanup();
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}
