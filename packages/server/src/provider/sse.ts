export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			const dataLines: string[] = [];
			for (const rawLine of part.split("\n")) {
				const line = rawLine.trim();
				if (!line || line.startsWith(":")) continue;
				if (line.startsWith("data:")) {
					dataLines.push(line.slice("data:".length).trimStart());
				}
			}
			if (dataLines.length === 0) continue;

			const data = dataLines.join("\n");
			if (data === "[DONE]") return;

			yield JSON.parse(data);
		}
	}
}
